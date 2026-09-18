import Foundation

public enum CollabGuestClientError: LocalizedError, Sendable {
    case notConnected
    case readOnly
    case protocolMismatch(expected: Int, received: Int)
    case badKeyOrCorruptedFrame
    case invalidRelayURL
    case sessionEnded(String)

    public var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Pi Collab guest is not connected."
        case .readOnly:
            return "This Pi Collab link is read-only."
        case let .protocolMismatch(expected, received):
            return "Pi Collab protocol mismatch: expected v\(expected), received v\(received)."
        case .badKeyOrCorruptedFrame:
            return "Pi Collab frame could not be decrypted with the room key."
        case .invalidRelayURL:
            return "Pi Collab relay URL is invalid."
        case let .sessionEnded(reason):
            return reason
        }
    }
}

public enum CollabGuestClientEvent: Sendable {
    case snapshot(CollabGuestSnapshot)
    case frame(CollabHostFrame)
    case relayControl(String)
    case disconnected(reason: String, willReconnect: Bool)
}

public actor CollabGuestClient {
    private static let welcomeTimeoutNanoseconds: UInt64 = 30_000_000_000
    private static let snapshotTimeoutNanoseconds: UInt64 = 30_000_000_000
    private static let backoffBaseSeconds = 1.0
    private static let backoffMaxSeconds = 30.0

    public nonisolated let events: AsyncStream<CollabGuestClientEvent>

    private let continuation: AsyncStream<CollabGuestClientEvent>.Continuation
    private let parsed: ParsedCollabLink
    private let displayName: String
    private let session: URLSession

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var welcomeTimeoutTask: Task<Void, Never>?
    private var snapshotTimeoutTask: Task<Void, Never>?

    private var replica = CollabGuestReplica()
    private var intentionalClose = false
    private var everConnected = false
    private var welcomed = false
    private var retryMissingRoom = false
    private var reconnectAttempt = 0

    public init(
        link: String,
        displayName: String,
        session: URLSession = URLSession(configuration: .default)
    ) throws {
        self.parsed = try CollabLinkParser.parse(link)
        self.displayName = displayName
        self.session = session

        let pair = AsyncStream.makeStream(
            of: CollabGuestClientEvent.self,
            bufferingPolicy: .bufferingNewest(256)
        )
        self.events = pair.stream
        self.continuation = pair.continuation
    }

    deinit {
        continuation.finish()
    }

    public func currentSnapshot() -> CollabGuestSnapshot {
        replica.snapshot
    }

    public func connect() {
        guard socket == nil, reconnectTask == nil else {
            return
        }

        intentionalClose = false
        retryMissingRoom = false
        reconnectAttempt = 0
        welcomed = false
        replica.markConnecting()
        emitSnapshot()
        openSocket()
    }

    public func close() {
        intentionalClose = true
        cancelTimers()
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil

        let task = socket
        socket = nil
        task?.cancel(with: .normalClosure, reason: nil)

        if replica.snapshot.phase != .ended {
            replica.end(reason: "closed")
            emitSnapshot()
        }
        continuation.yield(
            .disconnected(reason: "closed", willReconnect: false)
        )
    }

    public func sendPrompt(
        _ text: String,
        images: [JSONValue]? = nil
    ) async throws {
        try ensureWritable()
        try await send(.prompt(text: text, images: images))
    }

    public func sendAbort() async throws {
        try ensureWritable()
        try await send(.abort)
    }

    public func sendUiResponse(
        reqId: Int,
        value: String?
    ) async throws {
        try ensureWritable()
        try await send(.uiResponse(reqId: reqId, value: value))
        replica.didAnswerUiRequest(reqId: reqId)
        emitSnapshot()
    }

    public func sendAgentCommand(
        _ command: CollabAgentCommand,
        agentId: String,
        text: String? = nil
    ) async throws {
        try ensureWritable()
        try await send(
            .agentCommand(
                command: command,
                agentId: agentId,
                text: text
            )
        )
    }

    public func fetchTranscript(
        reqId: Int,
        agentId: String,
        fromByte: Int
    ) async throws {
        try await send(
            .fetchTranscript(
                reqId: reqId,
                agentId: agentId,
                fromByte: fromByte
            )
        )
    }

    private func openSocket() {
        guard !intentionalClose else { return }

        guard var components = URLComponents(
            url: parsed.webSocketURL,
            resolvingAgainstBaseURL: false
        ) else {
            endFatal(CollabGuestClientError.invalidRelayURL.localizedDescription)
            return
        }
        components.queryItems = [URLQueryItem(name: "role", value: "guest")]
        guard let url = components.url else {
            endFatal(CollabGuestClientError.invalidRelayURL.localizedDescription)
            return
        }

        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.sendHello(on: task)
                await self.didOpen(task)
            } catch {
                await self.handleTransportEnd(task, error: error)
            }
        }
    }

    private func sendHello(
        on task: URLSessionWebSocketTask
    ) async throws {
        let writeToken = parsed.writeToken?.base64URLEncodedString()
        let sealed = try CollabCodec.sealGuestFrame(
            .hello(
                name: displayName,
                writeToken: writeToken
            ),
            roomKey: parsed.roomKey
        )
        let envelope = CollabEnvelope(
            peerId: 0,
            payload: sealed
        ).encoded()

        try await task.send(.data(envelope))
    }

    private func didOpen(_ task: URLSessionWebSocketTask) {
        guard socket === task, !intentionalClose else {
            return
        }

        if everConnected {
            replica.markReconnecting()
        } else {
            replica.markWaiting()
        }
        everConnected = true
        emitSnapshot()
        armWelcomeTimeout(for: task)
    }

    private func send(_ frame: CollabGuestFrame) async throws {
        guard !intentionalClose,
              let task = socket
        else {
            throw CollabGuestClientError.notConnected
        }

        let sealed = try CollabCodec.sealGuestFrame(
            frame,
            roomKey: parsed.roomKey
        )
        let envelope = CollabEnvelope(
            peerId: 0,
            payload: sealed
        ).encoded()

        try await task.send(.data(envelope))
    }

    private func ensureWritable() throws {
        guard socket != nil, replica.snapshot.phase != .ended else {
            throw CollabGuestClientError.notConnected
        }
        if replica.snapshot.readOnly {
            throw CollabGuestClientError.readOnly
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled, socket === task, !intentionalClose {
            do {
                let message = try await task.receive()

                switch message {
                case let .data(data):
                    try handleBinary(data, from: task)

                case let .string(text):
                    continuation.yield(.relayControl(text))

                @unknown default:
                    continue
                }
            } catch {
                await handleTransportEnd(task, error: error)
                return
            }
        }
    }

    private func handleBinary(
        _ data: Data,
        from task: URLSessionWebSocketTask
    ) throws {
        guard socket === task else { return }

        let envelope = try CollabEnvelope.decode(data)

        let frame: CollabHostFrame
        do {
            frame = try CollabCodec.openHostFrame(
                envelope.payload,
                roomKey: parsed.roomKey
            )
        } catch {
            endFatal(
                CollabGuestClientError.badKeyOrCorruptedFrame.localizedDescription
            )
            throw CollabGuestClientError.badKeyOrCorruptedFrame
        }

        retryMissingRoom = false
        reconnectAttempt = 0

        if case let .welcome(proto, _, _, _, entryCount, _) = frame {
            guard proto == collabProtocolVersion else {
                let error = CollabGuestClientError.protocolMismatch(
                    expected: collabProtocolVersion,
                    received: proto
                )
                endFatal(error.localizedDescription)
                throw error
            }

            welcomed = true
            welcomeTimeoutTask?.cancel()
            welcomeTimeoutTask = nil

            if entryCount == 0 {
                snapshotTimeoutTask?.cancel()
                snapshotTimeoutTask = nil
            } else {
                armSnapshotTimeout(for: task)
            }
        } else if case let .snapshotChunk(_, final) = frame {
            if final {
                snapshotTimeoutTask?.cancel()
                snapshotTimeoutTask = nil
            } else {
                armSnapshotTimeout(for: task)
            }
        }

        let preWelcomeError: String?
        if !welcomed,
           case let .error(message) = frame
        {
            preWelcomeError = message
        } else {
            preWelcomeError = nil
        }

        replica.apply(frame)
        continuation.yield(.frame(frame))
        emitSnapshot()

        if let preWelcomeError {
            endFatal(preWelcomeError)
            return
        }

        if case let .bye(reason) = frame {
            endFatal(reason)
        }
    }

    private func handleTransportEnd(
        _ task: URLSessionWebSocketTask,
        error: Error
    ) async {
        guard socket === task, !intentionalClose else {
            return
        }

        receiveTask?.cancel()
        receiveTask = nil
        socket = nil
        cancelTimers()

        let code = task.closeCode.rawValue
        let decision = CollabRelayClosePolicy.decide(
            code: code,
            reason: closeReason(task) ?? error.localizedDescription,
            retryMissingRoom: retryMissingRoom
        )

        switch decision {
        case let .retry(nextRetryMissingRoom):
            retryMissingRoom = nextRetryMissingRoom
            replica.markReconnecting()
            emitSnapshot()
            continuation.yield(
                .disconnected(
                    reason: closeReason(task) ?? error.localizedDescription,
                    willReconnect: true
                )
            )
            scheduleReconnect()

        case let .fatal(reason):
            endFatal(reason)
        }
    }

    private func scheduleReconnect() {
        guard !intentionalClose, reconnectTask == nil else {
            return
        }

        let base = min(
            Self.backoffBaseSeconds * pow(2.0, Double(reconnectAttempt)),
            Self.backoffMaxSeconds
        )
        reconnectAttempt += 1
        let delay = base * Double.random(in: 0.75...1.25)

        reconnectTask = Task { [weak self] in
            do {
                try await Task.sleep(
                    nanoseconds: UInt64(delay * 1_000_000_000)
                )
            } catch {
                return
            }

            guard let self else { return }
            await self.clearReconnectTaskAndOpen()
        }
    }

    private func clearReconnectTaskAndOpen() {
        reconnectTask = nil
        openSocket()
    }

    private func armWelcomeTimeout(
        for task: URLSessionWebSocketTask
    ) {
        welcomeTimeoutTask?.cancel()
        welcomeTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(
                    nanoseconds: Self.welcomeTimeoutNanoseconds
                )
            } catch {
                return
            }

            guard let self else { return }
            await self.welcomeTimedOut(task)
        }
    }

    private func welcomeTimedOut(
        _ task: URLSessionWebSocketTask
    ) {
        guard socket === task, !welcomed else {
            return
        }
        endFatal("timed out waiting for the host's welcome")
    }

    private func armSnapshotTimeout(
        for task: URLSessionWebSocketTask
    ) {
        snapshotTimeoutTask?.cancel()
        snapshotTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(
                    nanoseconds: Self.snapshotTimeoutNanoseconds
                )
            } catch {
                return
            }

            guard let self else { return }
            await self.snapshotTimedOut(task)
        }
    }

    private func snapshotTimedOut(
        _ task: URLSessionWebSocketTask
    ) {
        guard socket === task else { return }
        endFatal("timed out waiting for the host's session snapshot")
    }

    private func cancelTimers() {
        welcomeTimeoutTask?.cancel()
        welcomeTimeoutTask = nil
        snapshotTimeoutTask?.cancel()
        snapshotTimeoutTask = nil
    }

    private func endFatal(_ reason: String) {
        intentionalClose = true
        cancelTimers()
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil

        let task = socket
        socket = nil
        task?.cancel(with: .normalClosure, reason: nil)

        replica.end(reason: reason)
        emitSnapshot()
        continuation.yield(
            .disconnected(reason: reason, willReconnect: false)
        )
    }

    private func emitSnapshot() {
        continuation.yield(.snapshot(replica.snapshot))
    }

    private func closeReason(
        _ task: URLSessionWebSocketTask
    ) -> String? {
        guard let data = task.closeReason,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty
        else {
            return nil
        }
        return value
    }
}
