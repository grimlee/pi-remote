import Foundation

actor RelayClient {
    enum Event: Sendable {
        case machinesSnapshot([RemoteMachine])
        case machinePresence(machineId: String, online: Bool)
    }

    enum RelayError: LocalizedError, Sendable {
        case notConnected
        case invalidFrame
        case remote(code: String, message: String)

        var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Pi Remote Relay is not connected."
            case .invalidFrame:
                return "Pi Remote Relay returned an invalid frame."
            case let .remote(_, message):
                return message
            }
        }
    }

    struct Configuration: Sendable {
        let url: URL
        let token: String
        let deviceId: String
        let deviceName: String
    }

    private struct FrameHeader: Decodable {
        let protocolVersion: Int
        let type: String
    }

    private struct ClientHello: Encodable {
        let protocolVersion = 0
        let type = "client.hello"
        let device: Device

        struct Device: Encodable {
            let id: String
            let name: String
        }
    }

    private struct MachinesSnapshotFrame: Decodable {
        let protocolVersion: Int
        let type: String
        let machines: [RemoteMachine]
    }

    private struct MachinePresenceFrame: Decodable {
        let protocolVersion: Int
        let type: String
        let machineId: String
        let online: Bool
    }

    private struct ControlRequest<Payload: Encodable & Sendable>: Encodable, Sendable {
        let protocolVersion = 0
        let type = "control.request"
        let requestId: String
        let machineId: String
        let payload: Payload
    }

    private struct SessionsListPayload: Encodable, Sendable {
        let op = "sessions.list"
    }

    private struct SessionsLinkPayload: Encodable, Sendable {
        let op = "sessions.link"
        let instanceId: String
        let generation: Int
        let access: RemoteSession.Access
    }

    private struct SessionsListResponsePayload: Decodable {
        let op: String
        let sessions: [RemoteSession]
    }

    private struct SessionsLinkResponsePayload: Decodable {
        let op: String
        let instanceId: String
        let generation: Int
        let access: RemoteSession.Access
        let collabUrl: String
    }

    private struct RemoteError: Decodable {
        let code: String
        let message: String
    }

    private struct ControlResponse<Payload: Decodable>: Decodable {
        let protocolVersion: Int
        let type: String
        let requestId: String
        let machineId: String
        let ok: Bool
        let payload: Payload?
        let error: RemoteError?
    }

    private let configuration: Configuration
    private let onEvent: @Sendable (Event) async -> Void
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pendingSessionLists: [String: CheckedContinuation<[RemoteSession], Error>] = [:]
    private var pendingSessionLinks: [String: CheckedContinuation<SessionLink, Error>] = [:]

    init(
        configuration: Configuration,
        onEvent: @escaping @Sendable (Event) async -> Void
    ) {
        self.configuration = configuration
        self.onEvent = onEvent
        self.session = URLSession(configuration: .default)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    func connect() async throws {
        disconnect()

        var request = URLRequest(url: configuration.url)
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")

        let socket = session.webSocketTask(with: request)
        self.socket = socket
        socket.resume()

        try await send(
            ClientHello(
                device: .init(
                    id: configuration.deviceId,
                    name: configuration.deviceName
                )
            )
        )

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil

        let error = CancellationError()
        for continuation in pendingSessionLists.values {
            continuation.resume(throwing: error)
        }
        pendingSessionLists.removeAll()

        for continuation in pendingSessionLinks.values {
            continuation.resume(throwing: error)
        }
        pendingSessionLinks.removeAll()
    }

    func listSessions(machineId: String) async throws -> [RemoteSession] {
        let requestId = UUID().uuidString
        let request = ControlRequest(
            requestId: requestId,
            machineId: machineId,
            payload: SessionsListPayload()
        )

        return try await withCheckedThrowingContinuation { continuation in
            pendingSessionLists[requestId] = continuation
            Task { [weak self] in
                do {
                    try await self?.send(request)
                } catch {
                    await self?.failSessionList(requestId: requestId, error: error)
                }
            }
        }
    }

    func requestSessionLink(
        machineId: String,
        instanceId: String,
        generation: Int,
        access: RemoteSession.Access
    ) async throws -> SessionLink {
        let requestId = UUID().uuidString
        let request = ControlRequest(
            requestId: requestId,
            machineId: machineId,
            payload: SessionsLinkPayload(
                instanceId: instanceId,
                generation: generation,
                access: access
            )
        )

        return try await withCheckedThrowingContinuation { continuation in
            pendingSessionLinks[requestId] = continuation
            Task { [weak self] in
                do {
                    try await self?.send(request)
                } catch {
                    await self?.failSessionLink(requestId: requestId, error: error)
                }
            }
        }
    }

    private func send<T: Encodable>(_ frame: T) async throws {
        guard let socket else { throw RelayError.notConnected }
        let data = try encoder.encode(frame)
        try await socket.send(.data(data))
    }

    private func receiveLoop() async {
        while !Task.isCancelled, let socket {
            do {
                let message = try await socket.receive()
                let data: Data

                switch message {
                case let .data(value):
                    data = value
                case let .string(value):
                    guard let value = value.data(using: .utf8) else {
                        throw RelayError.invalidFrame
                    }
                    data = value
                @unknown default:
                    throw RelayError.invalidFrame
                }

                try await handle(data)
            } catch {
                if !Task.isCancelled {
                    failAllPending(error)
                }
                return
            }
        }
    }

    private func handle(_ data: Data) async throws {
        let header = try decoder.decode(FrameHeader.self, from: data)
        guard header.protocolVersion == 0 else { throw RelayError.invalidFrame }

        switch header.type {
        case "machines.snapshot":
            let frame = try decoder.decode(MachinesSnapshotFrame.self, from: data)
            await onEvent(.machinesSnapshot(frame.machines))

        case "machine.presence":
            let frame = try decoder.decode(MachinePresenceFrame.self, from: data)
            await onEvent(.machinePresence(machineId: frame.machineId, online: frame.online))

        case "control.response":
            try handleControlResponse(data)

        default:
            break
        }
    }

    private func handleControlResponse(_ data: Data) throws {
        struct ResponseHeader: Decodable {
            let requestId: String
        }

        let header = try decoder.decode(ResponseHeader.self, from: data)

        if let continuation = pendingSessionLists.removeValue(forKey: header.requestId) {
            let response = try decoder.decode(
                ControlResponse<SessionsListResponsePayload>.self,
                from: data
            )
            guard response.ok, let payload = response.payload else {
                let error = response.error
                continuation.resume(
                    throwing: RelayError.remote(
                        code: error?.code ?? "internal_error",
                        message: error?.message ?? "The host rejected the request."
                    )
                )
                return
            }
            continuation.resume(returning: payload.sessions)
            return
        }

        if let continuation = pendingSessionLinks.removeValue(forKey: header.requestId) {
            let response = try decoder.decode(
                ControlResponse<SessionsLinkResponsePayload>.self,
                from: data
            )
            guard response.ok, let payload = response.payload else {
                let error = response.error
                continuation.resume(
                    throwing: RelayError.remote(
                        code: error?.code ?? "internal_error",
                        message: error?.message ?? "The host rejected the request."
                    )
                )
                return
            }
            continuation.resume(
                returning: SessionLink(
                    instanceId: payload.instanceId,
                    generation: payload.generation,
                    access: payload.access,
                    collabUrl: payload.collabUrl
                )
            )
        }
    }

    private func failSessionList(requestId: String, error: Error) {
        pendingSessionLists.removeValue(forKey: requestId)?.resume(throwing: error)
    }

    private func failSessionLink(requestId: String, error: Error) {
        pendingSessionLinks.removeValue(forKey: requestId)?.resume(throwing: error)
    }

    private func failAllPending(_ error: Error) {
        for continuation in pendingSessionLists.values {
            continuation.resume(throwing: error)
        }
        pendingSessionLists.removeAll()

        for continuation in pendingSessionLinks.values {
            continuation.resume(throwing: error)
        }
        pendingSessionLinks.removeAll()
    }
}
