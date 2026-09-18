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
        case closed
        case remote(String)

        var errorDescription: String? {
            switch self {
            case .invalidCapability:
                return "The host returned an invalid Pi RPC channel."
            case .invalidFrame:
                return "The Pi RPC channel returned an invalid encrypted frame."
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
    private let sendFrame: @Sendable (PiRpcRelayFrame) async throws -> Void
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var snapshot: PiRpcSnapshot
    private var nextClientSequence: Int64 = 1
    private var lastHostSequence: Int64 = 0
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
        self.capability = try PiRpcCapability.parse(capabilityString)
        self.machineId = machineId
        self.deviceId = deviceId
        self.snapshot = PiRpcSnapshot(messages: initialMessages)
        self.sendFrame = sendFrame
    }

    func start() async throws {
        guard !isClosed else { throw ClientError.closed }
        snapshot.phase = .connecting
        emitSnapshot()

        try await sendCommand([
            "id": .string("bootstrap-state"),
            "type": .string("get_state")
        ])
        try await sendCommand([
            "id": .string("bootstrap-messages"),
            "type": .string("get_messages")
        ])
        try await sendCommand([
            "id": .string("bootstrap-models"),
            "type": .string("get_available_models")
        ])
    }

    func startFreshSession() async throws {
        guard !isClosed else { throw ClientError.closed }

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

        try await sendCommand([
            "id": .string("fresh-state-" + UUID().uuidString),
            "type": .string("get_state")
        ])
        try await sendCommand([
            "id": .string("fresh-messages-" + UUID().uuidString),
            "type": .string("get_messages")
        ])
        try await sendCommand([
            "id": .string("fresh-models-" + UUID().uuidString),
            "type": .string("get_available_models")
        ])
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
    }

    func receive(_ frame: PiRpcRelayFrame) throws {
        guard !isClosed else { return }
        guard frame.machineId == machineId,
              frame.deviceId == deviceId,
              frame.channelId == capability.channelId,
              frame.direction == .host,
              frame.seq > lastHostSequence
        else {
            throw ClientError.invalidFrame
        }

        let plaintext = try PiRpcChannelCrypto.open(
            frame,
            keyBase64URL: capability.key
        )
        let value = try decoder.decode(JSONValue.self, from: plaintext)
        lastHostSequence = frame.seq
        handle(value)
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
        try await sendCommand(command)
    }

    func abort() async throws {
        try await sendCommand([
            "id": .string(UUID().uuidString),
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
        try await sendCommand(response)
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
                    try await sendCommand(command)
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
        let data = try encoder.encode(JSONValue.object(object))
        let frame = try PiRpcChannelCrypto.seal(
            plaintext: data,
            keyBase64URL: capability.key,
            machineId: machineId,
            deviceId: deviceId,
            channelId: capability.channelId,
            direction: .client,
            seq: nextClientSequence
        )
        nextClientSequence += 1
        try await sendFrame(frame)
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
        case "ready":
            snapshot.phase = .live
            snapshot.lastEvent = value

        case "response":
            let command = object["command"]?.stringValue
            let success = object["success"]?.boolValue ?? false

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
            } else {
                snapshot.lastEvent = value
            }

            completePendingResponse(object)

        case "message_start":
            if let message = object["message"] {
                snapshot.liveMessage = message
            }
            snapshot.lastEvent = value

        case "message_update":
            applyMessageUpdate(object)
            snapshot.lastEvent = value

        case "message_end":
            if let message = object["message"] {
                snapshot.messages.append(message)
                snapshot.messageRevision += 1
            }
            snapshot.liveMessage = nil
            snapshot.lastEvent = value

        case "agent_start":
            setStreaming(true)
            snapshot.lastEvent = value

        case "agent_end":
            setStreaming(false)
            snapshot.lastEvent = value

        case "extension_ui_request":
            let method = object["method"]?.stringValue ?? ""
            if ["select", "confirm", "input", "editor"].contains(method) {
                snapshot.uiRequest = value
            } else {
                snapshot.lastEvent = value
            }

        case "piremote.channel_closed":
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
            snapshot.lastEvent = value
        }

        emitSnapshot()
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
            appendDelta(
                update["delta"]?.stringValue ?? "",
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
            appendDelta(
                update["delta"]?.stringValue ?? "",
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

    private func setStreaming(_ streaming: Bool) {
        var object = snapshot.state?.objectValue ?? [:]
        object["isStreaming"] = .bool(streaming)
        snapshot.state = .object(object)
    }

    private func emitSnapshot() {
        continuation.yield(.snapshot(snapshot))
    }
}
