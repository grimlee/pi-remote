import Foundation
import PiRemoteCore

struct PiRpcSnapshot: Sendable {
    enum Phase: String, Sendable {
        case connecting
        case live
        case closed
    }

    var phase: Phase = .connecting
    var messages: [JSONValue] = []
    var liveMessage: JSONValue?
    var messageRevision: Int = 0
    var state: JSONValue?
    var availableModels: [PiModelOption] = []
    var availableThinkingLevels: [String] = []
    var availableCommands: [PiSlashCommandOption] = []
    var sessionStats: JSONValue?
    var decodeTokensPerSecond: Double?
    var diagnosticEvent: String?
    var presentationRevision: Int = 0
    var liveCharacterCount: Int = 0
    var lastEvent: JSONValue?
    var uiRequest: JSONValue?
    var readOnly: Bool { false }
}

enum PiRpcClientEvent: Sendable {
    case snapshot(PiRpcSnapshot)
    case disconnected(String)
}

actor PiRpcClient {
    enum ClientError: LocalizedError {
        case invalidCapability
        case invalidFrame
        case sequenceGap(expected: Int64, received: Int64)
        case reliableQueueFull
        case deliveredResponseUnavailable(String)
        case closed
        case remote(String)

        var errorDescription: String? {
            switch self {
            case .invalidCapability:
                return "The host returned an invalid Pi RPC channel."
            case .invalidFrame:
                return "The Pi RPC channel returned an invalid encrypted frame."
            case let .sequenceGap(expected, received):
                return "Pi RPC event gap detected: expected seq \(expected), received \(received)."
            case .reliableQueueFull:
                return "Too many Pi commands are waiting for delivery confirmation."
            case let .deliveredResponseUnavailable(command):
                return "The \(command) command reached the Host, but its Pi response fell outside the replay window. State is being reconciled; the command was not retried."
            case .closed:
                return "The Pi RPC channel is closed."
            case let .remote(message):
                return message
            }
        }
    }

    nonisolated let events: AsyncStream<PiRpcClientEvent>

    private let continuation: AsyncStream<PiRpcClientEvent>.Continuation
    private let capability: PiRpcCapability
    private let machineId: String
    private let deviceId: String
    private var sendFrame: @Sendable (PiRpcRelayFrame) async throws -> Void
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var snapshot: PiRpcSnapshot
    private var liveMutableCharacterCount = 0
    private var decodeDeltaTimestamps: [TimeInterval] = []
    private var lastDecodeDeltaAt: TimeInterval?
    private let decodeWindowSeconds: TimeInterval = 1.0
    private var lastLiveSnapshotEmissionAt: TimeInterval = 0
    private var nextClientSequence: Int64 = 1
    private var lastHostSequence: Int64 = 0
    private var didAcknowledgeInitialBarrier = false
    private struct ReliableCommand: Sendable {
        var sequence: Int64
        let commandId: String?
        let commandType: String
        let object: [String: JSONValue]
    }

    private let maxReliableCommands = 128
    private var reliableCommands: [ReliableCommand] = []
    private var isClosed = false
    private var pendingResponses:
        [String: CheckedContinuation<JSONValue, Error>] = [:]

    init(
        capabilityString: String,
        machineId: String,
        deviceId: String,
        initialMessages: [JSONValue] = [],
        sendFrame: @escaping @Sendable (PiRpcRelayFrame) async throws -> Void
    ) throws {
        let stream = AsyncStream<PiRpcClientEvent>.makeStream()
        self.events = stream.stream
        self.continuation = stream.continuation
        let parsedCapability = try PiRpcCapability.parse(capabilityString)
        self.capability = parsedCapability
        self.machineId = machineId
        self.deviceId = deviceId
        self.snapshot = PiRpcSnapshot(messages: initialMessages)
        self.sendFrame = sendFrame
        self.nextClientSequence = parsedCapability.nextClientSeq ?? 1
        self.lastHostSequence = parsedCapability.lastHostSeq ?? 0
    }

    func start() async throws {
        guard !isClosed else { throw ClientError.closed }
        snapshot.phase = .connecting
        emitSnapshot()

        try await acknowledgeInitialBarrierIfNeeded()
        try await refreshAuthoritativeState(prefix: "bootstrap")
    }

    func resumeTransport(
        capabilityString: String,
        sendFrame: @escaping @Sendable (PiRpcRelayFrame) async throws -> Void
    ) async throws -> Bool {
        guard !isClosed else { return false }

        let resumedCapability = try PiRpcCapability.parse(
            capabilityString
        )
        guard resumedCapability.channelId == capability.channelId,
              resumedCapability.key == capability.key,
              resumedCapability.wireProtocol == capability.wireProtocol
        else {
            return false
        }

        self.sendFrame = sendFrame
        let hostNextClientSeq = resumedCapability.nextClientSeq
            ?? self.nextClientSequence
        self.nextClientSequence = hostNextClientSeq

        if let resumeToken = resumedCapability.resumeToken,
           let resumeFromHostSeq = resumedCapability.resumeFromHostSeq,
           let targetHostSeq = resumedCapability.resumeTargetHostSeq,
           let replayAvailable = resumedCapability.replayAvailable {
            guard resumeFromHostSeq <= lastHostSequence else {
                return false
            }

            if replayAvailable {
                try await waitForHostSequence(targetHostSeq)
            } else {
                // The Host ring buffer no longer reaches our cursor.
                // Advance to the barrier snapshot and repair durable state
                // from Pi before accepting post-barrier live frames.
                lastHostSequence = max(
                    lastHostSequence,
                    targetHostSeq
                )
                snapshot.liveMessage = nil
                snapshot.uiRequest = nil
            }

            try await resendUnacknowledgedCommands(
                hostNextClientSeq: hostNextClientSeq,
                responseReplayAvailable: replayAvailable
            )

            try await sendCommand([
                "type": .string("piremote.resume_ack"),
                "resumeToken": .string(resumeToken),
                "hostSeq": .integer(targetHostSeq)
            ])
        } else if let lastHostSeq = resumedCapability.lastHostSeq {
            // Compatibility path for a reused channel that predates replay
            // metadata. Reconcile from Pi rather than treating old deltas as
            // authoritative.
            lastHostSequence = max(
                lastHostSequence,
                lastHostSeq
            )
            snapshot.liveMessage = nil
            try await resendUnacknowledgedCommands(
                hostNextClientSeq: hostNextClientSeq,
                responseReplayAvailable: true
            )
        }

        try await refreshAuthoritativeState(prefix: "resume")
        return true
    }

    func startFreshSession() async throws {
        guard !isClosed else { throw ClientError.closed }

        try await acknowledgeInitialBarrierIfNeeded()
        snapshot.phase = .connecting
        snapshot.messages = []
        snapshot.liveMessage = nil
        snapshot.messageRevision += 1
        snapshot.state = nil
        emitSnapshot()

        let result = try await sendRequest([
            "type": .string("new_session")
        ])
        if result.objectValue?["cancelled"]?.boolValue == true {
            throw ClientError.remote(
                "A Pi extension cancelled the new session."
            )
        }

        try await refreshAuthoritativeState(prefix: "fresh")
    }

    func selectModel(_ model: PiModelOption) async throws {
        let data = try await sendRequest([
            "type": .string("set_model"),
            "provider": .string(model.provider),
            "modelId": .string(model.modelId)
        ])

        var state = snapshot.state?.objectValue ?? [:]
        state["model"] = data
        snapshot.state = .object(state)
        emitSnapshot()

        try await refreshThinkingLevels(prefix: "model")
        try await refreshSessionStats(prefix: "model")
    }

    func setThinkingLevel(_ level: String) async throws {
        _ = try await sendRequest([
            "type": .string("set_thinking_level"),
            "level": .string(level)
        ])

        var state = snapshot.state?.objectValue ?? [:]
        state["thinkingLevel"] = .string(level)
        snapshot.state = .object(state)
        emitSnapshot()
    }

    func compact(_ instructions: String?) async throws -> JSONValue {
        var command: [String: JSONValue] = [
            "type": .string("compact")
        ]
        if let instructions, !instructions.isEmpty {
            command["customInstructions"] = .string(instructions)
        }

        let result = try await sendRequest(command)
        try await refreshAuthoritativeState(prefix: "compact")
        return result
    }

    func setSessionName(_ name: String) async throws {
        _ = try await sendRequest([
            "type": .string("set_session_name"),
            "name": .string(name)
        ])

        var state = snapshot.state?.objectValue ?? [:]
        state["sessionName"] = .string(name)
        snapshot.state = .object(state)
        emitSnapshot()
    }

    func sessionStats() async throws -> JSONValue {
        try await sendRequest([
            "type": .string("get_session_stats")
        ])
    }

    func lastAssistantText() async throws -> String? {
        let data = try await sendRequest([
            "type": .string("get_last_assistant_text")
        ])
        return data.objectValue?["text"]?.stringValue
    }

    func receive(_ frame: PiRpcRelayFrame) throws {
        guard !isClosed else { return }
        guard frame.machineId == machineId,
              frame.deviceId == deviceId,
              frame.channelId == capability.channelId,
              frame.direction == .host
        else {
            throw ClientError.invalidFrame
        }

        if frame.seq <= lastHostSequence {
            return
        }
        let expected = lastHostSequence + 1
        guard frame.seq == expected else {
            throw ClientError.sequenceGap(
                expected: expected,
                received: frame.seq
            )
        }

        let plaintext = try PiRpcChannelCrypto.open(
            frame,
            keyBase64URL: capability.key
        )
        let value = try decoder.decode(JSONValue.self, from: plaintext)
        lastHostSequence = frame.seq
        handle(value)
    }

    func hostSequenceCursor() -> Int64 {
        lastHostSequence
    }

    func sendPrompt(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        var command: [String: JSONValue] = [
            "id": .string(UUID().uuidString),
            "type": .string("prompt"),
            "message": .string(trimmed)
        ]
        if snapshot.state?.objectValue?["isStreaming"]?.boolValue == true {
            command["streamingBehavior"] = .string("followUp")
        }

        // Prompt completion is delivered by the agent/message event stream.
        // Waiting for a terminal Pi response keeps the composer occupied even
        // after the assistant has finished. The reliable-command journal plus
        // Host client ACK still guarantees retry-safe delivery.
        try await sendReliableCommand(command)
    }

    func abort() async throws {
        _ = try await sendRequest([
            "type": .string("abort")
        ])
    }

    func answerInteractiveRequest(
        id: String,
        method: String,
        value: String?,
        confirmed: Bool? = nil
    ) async throws {
        var response: [String: JSONValue] = [
            "type": .string("extension_ui_response"),
            "id": .string(id)
        ]
        if let confirmed {
            response["confirmed"] = .bool(confirmed)
        } else if let value {
            response["value"] = .string(value)
        } else {
            response["cancelled"] = .bool(true)
        }
        try await sendReliableCommand(response)
        if snapshot.uiRequest?.objectValue?["id"]?.stringValue == id {
            snapshot.uiRequest = nil
            emitSnapshot()
        }
    }

    func close() async {
        guard !isClosed else { return }
        do {
            try await sendCommand(["type": .string("piremote.close")])
        } catch {
            // Relay may already be gone during backgrounding.
        }
        isClosed = true
        failPending(ClientError.closed)
        snapshot.phase = .closed
        snapshot.liveMessage = nil
        emitSnapshot()
        continuation.finish()
    }

    private func acknowledgeInitialBarrierIfNeeded() async throws {
        guard !didAcknowledgeInitialBarrier,
              let resumeToken = capability.resumeToken,
              let targetHostSeq = capability.resumeTargetHostSeq
        else {
            return
        }

        try await sendCommand([
            "type": .string("piremote.resume_ack"),
            "resumeToken": .string(resumeToken),
            "hostSeq": .integer(targetHostSeq)
        ])
        didAcknowledgeInitialBarrier = true
    }

    private func waitForHostSequence(
        _ target: Int64
    ) async throws {
        guard target >= lastHostSequence else { return }

        for _ in 0..<250 {
            if lastHostSequence >= target {
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        throw ClientError.remote(
            "Timed out while replaying missed Pi RPC events."
        )
    }

    private func refreshAuthoritativeState(
        prefix: String
    ) async throws {
        let suffix = UUID().uuidString

        try await sendCommand([
            "id": .string("\(prefix)-state-\(suffix)"),
            "type": .string("get_state")
        ])
        try await sendCommand([
            "id": .string("\(prefix)-messages-\(suffix)"),
            "type": .string("get_messages")
        ])
        try await sendCommand([
            "id": .string("\(prefix)-models-\(suffix)"),
            "type": .string("get_available_models")
        ])
        try await refreshThinkingLevels(
            prefix: prefix,
            suffix: suffix
        )
        try await sendCommand([
            "id": .string("\(prefix)-commands-\(suffix)"),
            "type": .string("get_commands")
        ])
        try await refreshSessionStats(
            prefix: prefix,
            suffix: suffix
        )
    }

    private func refreshThinkingLevels(
        prefix: String,
        suffix: String = UUID().uuidString
    ) async throws {
        try await sendCommand([
            "id": .string("\(prefix)-thinking-\(suffix)"),
            "type": .string("get_available_thinking_levels")
        ])
    }

    private func refreshSessionStats(
        prefix: String,
        suffix: String = UUID().uuidString
    ) async throws {
        try await sendCommand([
            "id": .string("\(prefix)-stats-\(suffix)"),
            "type": .string("get_session_stats")
        ])
    }

    private func sendRequest(
        _ object: [String: JSONValue]
    ) async throws -> JSONValue {
        let requestId = UUID().uuidString
        var command = object
        command["id"] = .string(requestId)

        return try await withCheckedThrowingContinuation { continuation in
            pendingResponses[requestId] = continuation

            Task {
                do {
                    try await sendReliableCommand(command)
                } catch {
                    failPendingResponse(
                        requestId: requestId,
                        error: error
                    )
                }
            }
        }
    }

    private func sendCommand(_ object: [String: JSONValue]) async throws {
        guard !isClosed else { throw ClientError.closed }
        let sequence = nextClientSequence
        let frame = try makeClientFrame(
            object,
            sequence: sequence
        )
        nextClientSequence += 1
        try await sendFrame(frame)
    }

    private func sendReliableCommand(
        _ object: [String: JSONValue]
    ) async throws {
        guard !isClosed else { throw ClientError.closed }
        guard reliableCommands.count < maxReliableCommands else {
            throw ClientError.reliableQueueFull
        }

        let sequence = nextClientSequence
        let frame = try makeClientFrame(
            object,
            sequence: sequence
        )
        nextClientSequence += 1

        reliableCommands.append(
            ReliableCommand(
                sequence: sequence,
                commandId: object["id"]?.stringValue,
                commandType: object["type"]?.stringValue ?? "unknown",
                object: object
            )
        )

        do {
            try await sendFrame(frame)
        } catch {
            // Keep the command in the in-memory journal. A Relay send error
            // is ambiguous: the Host may or may not have received the frame.
            // The next sessions.link capability exposes Host nextClientSeq,
            // which is the authority for deciding whether this command must
            // be retried.
        }
    }

    private func resendUnacknowledgedCommands(
        hostNextClientSeq: Int64,
        responseReplayAvailable: Bool
    ) async throws {
        // Host sequence acceptance is contiguous. Any reliable command below
        // Host nextClientSeq is already delivered and must never be retried.
        let accepted = reliableCommands.filter {
            $0.sequence < hostNextClientSeq
        }
        if !responseReplayAvailable {
            for command in accepted {
                guard let commandId = command.commandId,
                      let continuation = pendingResponses.removeValue(
                        forKey: commandId
                      )
                else {
                    continue
                }
                continuation.resume(
                    throwing: ClientError
                        .deliveredResponseUnavailable(
                            command.commandType
                        )
                )
            }
        }

        reliableCommands.removeAll {
            $0.sequence < hostNextClientSeq
        }

        let pending = reliableCommands.sorted {
            $0.sequence < $1.sequence
        }
        reliableCommands.removeAll()
        nextClientSequence = hostNextClientSeq

        for var command in pending {
            let sequence = nextClientSequence
            let frame = try makeClientFrame(
                command.object,
                sequence: sequence
            )
            nextClientSequence += 1
            command.sequence = sequence
            reliableCommands.append(command)
            try await sendFrame(frame)
        }
    }

    private func makeClientFrame(
        _ object: [String: JSONValue],
        sequence: Int64
    ) throws -> PiRpcRelayFrame {
        let data = try encoder.encode(JSONValue.object(object))
        return try PiRpcChannelCrypto.seal(
            plaintext: data,
            keyBase64URL: capability.key,
            machineId: machineId,
            deviceId: deviceId,
            channelId: capability.channelId,
            direction: .client,
            seq: sequence
        )
    }

    private func handle(_ value: JSONValue) {
        guard let object = value.objectValue,
              let type = object["type"]?.stringValue
        else {
            snapshot.lastEvent = value
            emitSnapshot()
            return
        }

        switch type {
        case "piremote.client_ack":
            if let clientSeq = object["clientSeq"]?.integerValue,
               clientSeq >= 0 {
                reliableCommands.removeAll {
                    $0.sequence <= clientSeq
                }
            }
            return

        case "ready":
            snapshot.diagnosticEvent = "ready"
            snapshot.phase = .live
            snapshot.lastEvent = value

        case "response":
            let command = object["command"]?.stringValue
            let success = object["success"]?.boolValue ?? false
            snapshot.diagnosticEvent =
                "response." + (command ?? "unknown")

            if success,
               command == "get_state",
               let data = object["data"] {
                snapshot.state = data
                snapshot.phase = .live
            } else if success,
                      command == "get_messages",
                      let messages = object["data"]?
                        .objectValue?["messages"]?
                        .arrayValue {
                snapshot.messages = messages
                snapshot.messageRevision += 1
                snapshot.phase = .live
            } else if success,
                      command == "get_available_models",
                      let models = object["data"]?
                        .objectValue?["models"]?
                        .arrayValue {
                snapshot.availableModels = models
                    .compactMap(PiModelOption.parse)
                    .sorted {
                        if $0.provider == $1.provider {
                            return $0.displayName
                                .localizedCaseInsensitiveCompare(
                                    $1.displayName
                                ) == .orderedAscending
                        }
                        return $0.provider
                            .localizedCaseInsensitiveCompare(
                                $1.provider
                            ) == .orderedAscending
                    }
            } else if success,
                      command == "get_available_thinking_levels",
                      let levels = object["data"]?
                        .objectValue?["levels"]?
                        .arrayValue {
                snapshot.availableThinkingLevels = levels
                    .compactMap(\.stringValue)
            } else if success,
                      command == "get_commands",
                      let commands = object["data"]?
                        .objectValue?["commands"]?
                        .arrayValue {
                snapshot.availableCommands = commands
                    .compactMap(PiSlashCommandOption.parse)
                    .sorted {
                        $0.name.localizedCaseInsensitiveCompare(
                            $1.name
                        ) == .orderedAscending
                    }
            } else if success,
                      command == "get_session_stats",
                      let data = object["data"] {
                snapshot.sessionStats = data
            } else {
                snapshot.lastEvent = value
            }

            completePendingResponse(object)

        case "message_start":
            snapshot.diagnosticEvent = "message_start."
                + (object["message"]?
                    .objectValue?["role"]?
                    .stringValue ?? "unknown")
            liveMutableCharacterCount = 0
            snapshot.liveCharacterCount = 0
            if let message = object["message"] {
                snapshot.liveMessage = message
            }
            snapshot.lastEvent = value

        case "message_update":
            let updateType = object["assistantMessageEvent"]?
                .objectValue?["type"]?
                .stringValue ?? "unknown"
            snapshot.diagnosticEvent =
                "message_update." + updateType
            applyMessageUpdate(object)
            recordDecodeDeltaIfNeeded(object)
            snapshot.lastEvent = value

        case "message_end":
            snapshot.diagnosticEvent = "message_end."
                + (object["message"]?
                    .objectValue?["role"]?
                    .stringValue ?? "unknown")
            if let message = object["message"] {
                snapshot.messages.append(message)
                snapshot.messageRevision += 1
            }
            snapshot.liveMessage = nil
            liveMutableCharacterCount = 0
            snapshot.liveCharacterCount = 0
            snapshot.lastEvent = value

        case "agent_start":
            snapshot.diagnosticEvent = "agent_start"
            resetDecodeSpeed()
            setStreaming(true)
            snapshot.lastEvent = value

        case "agent_end":
            snapshot.diagnosticEvent = "agent_end"
            setStreaming(false)
            snapshot.lastEvent = value

        case "agent_settled":
            snapshot.diagnosticEvent = "agent_settled"
            snapshot.lastEvent = value
            Task { [weak self] in
                try? await self?.refreshSessionStats(
                    prefix: "settled"
                )
            }

        case "extension_ui_request":
            let method = object["method"]?.stringValue ?? ""
            snapshot.diagnosticEvent =
                "extension_ui_request." + method
            if ["select", "confirm", "input", "editor"].contains(method) {
                snapshot.uiRequest = value
            } else {
                snapshot.lastEvent = value
            }

        case "piremote.channel_closed":
            snapshot.diagnosticEvent = "piremote.channel_closed"
            isClosed = true
            failPending(ClientError.closed)
            snapshot.phase = .closed
            snapshot.liveMessage = nil
            snapshot.lastEvent = value
            continuation.yield(.snapshot(snapshot))
            continuation.yield(.disconnected("The Pi RPC process closed."))
            continuation.finish()
            return

        default:
            snapshot.diagnosticEvent = type
            snapshot.lastEvent = value
        }

        emitSnapshot(
            coalescingLiveUpdate: type == "message_update"
        )
    }

    private func completePendingResponse(
        _ object: [String: JSONValue]
    ) {
        guard let requestId = object["id"]?.stringValue,
              let continuation = pendingResponses.removeValue(
                forKey: requestId
              )
        else {
            return
        }

        reliableCommands.removeAll {
            $0.commandId == requestId
        }

        let success = object["success"]?.boolValue ?? false
        if success {
            continuation.resume(
                returning: object["data"] ?? .null
            )
        } else {
            continuation.resume(
                throwing: ClientError.remote(
                    object["error"]?.stringValue
                        ?? "Pi rejected the RPC request."
                )
            )
        }
    }

    private func failPendingResponse(
        requestId: String,
        error: Error
    ) {
        pendingResponses.removeValue(forKey: requestId)?
            .resume(throwing: error)
    }

    private func failPending(_ error: Error) {
        reliableCommands.removeAll()
        let pending = pendingResponses
        pendingResponses.removeAll()
        for continuation in pending.values {
            continuation.resume(throwing: error)
        }
    }

    private func applyMessageUpdate(_ object: [String: JSONValue]) {
        guard let update = object["assistantMessageEvent"]?.objectValue,
              let updateType = update["type"]?.stringValue,
              let rawIndex = update["contentIndex"]?.integerValue,
              let index = Int(exactly: rawIndex),
              index >= 0,
              var message = snapshot.liveMessage?.objectValue
        else {
            return
        }

        var content = message["content"]?.arrayValue ?? []
        while content.count <= index {
            content.append(.object([:]))
        }

        switch updateType {
        case "text_start":
            content[index] = .object([
                "type": .string("text"),
                "text": .string("")
            ])

        case "text_delta":
            let delta = update["delta"]?.stringValue ?? ""
            liveMutableCharacterCount += delta.count
            snapshot.liveCharacterCount = liveMutableCharacterCount
            appendDelta(
                delta,
                key: "text",
                type: "text",
                index: index,
                content: &content
            )

        case "text_end":
            content[index] = .object([
                "type": .string("text"),
                "text": .string(
                    update["content"]?.stringValue
                        ?? textValue(
                            content[index],
                            key: "text"
                        )
                )
            ])

        case "thinking_start":
            content[index] = .object([
                "type": .string("thinking"),
                "thinking": .string("")
            ])

        case "thinking_delta":
            let delta = update["delta"]?.stringValue ?? ""
            liveMutableCharacterCount += delta.count
            snapshot.liveCharacterCount = liveMutableCharacterCount
            appendDelta(
                delta,
                key: "thinking",
                type: "thinking",
                index: index,
                content: &content
            )

        case "thinking_end":
            content[index] = .object([
                "type": .string("thinking"),
                "thinking": .string(
                    update["content"]?.stringValue
                        ?? textValue(
                            content[index],
                            key: "thinking"
                        )
                )
            ])

        case "toolcall_start":
            var block: [String: JSONValue] = [
                "type": .string("toolCall"),
                "name": .string(
                    update["toolName"]?.stringValue ?? "Tool"
                )
            ]
            if let id = update["id"]?.stringValue {
                block["id"] = .string(id)
            }
            content[index] = .object(block)

        case "toolcall_end":
            if let toolCall = update["toolCall"]?.objectValue {
                var block = toolCall
                block["type"] = .string("toolCall")
                content[index] = .object(block)
            }

        default:
            break
        }

        message["content"] = .array(content)
        snapshot.liveMessage = .object(message)
    }

    private func appendDelta(
        _ delta: String,
        key: String,
        type: String,
        index: Int,
        content: inout [JSONValue]
    ) {
        var block = content[index].objectValue ?? [:]
        block["type"] = .string(type)
        let existing = block[key]?.stringValue ?? ""
        block[key] = .string(existing + delta)
        content[index] = .object(block)
    }

    private func textValue(
        _ value: JSONValue,
        key: String
    ) -> String {
        value.objectValue?[key]?.stringValue ?? ""
    }

    private func recordDecodeDeltaIfNeeded(
        _ object: [String: JSONValue]
    ) {
        guard let update = object["assistantMessageEvent"]?.objectValue,
              let type = update["type"]?.stringValue,
              type == "text_delta" || type == "thinking_delta"
        else {
            return
        }

        let now = ProcessInfo.processInfo.systemUptime
        let previous = lastDecodeDeltaAt
        lastDecodeDeltaAt = now

        decodeDeltaTimestamps.append(now)
        let cutoff = now - decodeWindowSeconds
        decodeDeltaTimestamps.removeAll { $0 < cutoff }

        if decodeDeltaTimestamps.count >= 2,
           let first = decodeDeltaTimestamps.first {
            let span = max(0.1, now - first)
            snapshot.decodeTokensPerSecond =
                Double(decodeDeltaTimestamps.count - 1) / span
        } else if let previous {
            let span = max(0.1, min(decodeWindowSeconds, now - previous))
            snapshot.decodeTokensPerSecond = 1.0 / span
        }
    }

    private func resetDecodeSpeed() {
        decodeDeltaTimestamps.removeAll(keepingCapacity: true)
        lastDecodeDeltaAt = nil
        snapshot.decodeTokensPerSecond = nil
    }

    private func setStreaming(_ streaming: Bool) {
        var object = snapshot.state?.objectValue ?? [:]
        object["isStreaming"] = .bool(streaming)
        snapshot.state = .object(object)
    }

    private func emitSnapshot(
        coalescingLiveUpdate: Bool = false
    ) {
        let now = ProcessInfo.processInfo.systemUptime

        if coalescingLiveUpdate,
           now - lastLiveSnapshotEmissionAt
                < liveSnapshotIntervalForCurrentLength() {
            return
        }

        lastLiveSnapshotEmissionAt = now
        snapshot.presentationRevision += 1
        continuation.yield(.snapshot(snapshot))
    }

    private func liveSnapshotIntervalForCurrentLength() -> TimeInterval {
        switch liveMutableCharacterCount {
        case ..<2_000:
            return 1.0 / 20.0
        case ..<6_000:
            return 1.0 / 15.0
        case ..<12_000:
            return 1.0 / 10.0
        default:
            return 1.0 / 8.0
        }
    }
}
