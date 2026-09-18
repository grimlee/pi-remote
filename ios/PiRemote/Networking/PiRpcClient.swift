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
    var state: JSONValue?
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

        var errorDescription: String? {
            switch self {
            case .invalidCapability:
                return "The host returned an invalid Pi RPC channel."
            case .invalidFrame:
                return "The Pi RPC channel returned an invalid encrypted frame."
            case .closed:
                return "The Pi RPC channel is closed."
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

    private var snapshot = PiRpcSnapshot()
    private var nextClientSequence: Int64 = 1
    private var lastHostSequence: Int64 = 0
    private var isClosed = false

    init(
        capabilityString: String,
        machineId: String,
        deviceId: String,
        sendFrame: @escaping @Sendable (PiRpcRelayFrame) async throws -> Void
    ) throws {
        let stream = AsyncStream<PiRpcClientEvent>.makeStream()
        self.events = stream.stream
        self.continuation = stream.continuation
        self.capability = try PiRpcCapability.parse(capabilityString)
        self.machineId = machineId
        self.deviceId = deviceId
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
        snapshot.phase = .closed
        emitSnapshot()
        continuation.finish()
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
                      let messages = object["data"]?.objectValue?["messages"]?.arrayValue {
                snapshot.messages = messages
                snapshot.phase = .live
            } else {
                snapshot.lastEvent = value
            }

        case "message_end":
            if let message = object["message"] {
                snapshot.messages.append(message)
            }
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
            snapshot.phase = .closed
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

    private func setStreaming(_ streaming: Bool) {
        var object = snapshot.state?.objectValue ?? [:]
        object["isStreaming"] = .bool(streaming)
        snapshot.state = .object(object)
    }

    private func emitSnapshot() {
        continuation.yield(.snapshot(snapshot))
    }
}
