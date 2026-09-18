import Foundation

public enum CollabConnectionPhase: String, Codable, Sendable {
    case connecting
    case waiting
    case live
    case reconnecting
    case ended
}

public struct CollabNotice: Equatable, Sendable {
    public enum Level: String, Sendable {
        case info
        case warning
        case error
    }

    public let id: Int
    public let level: Level
    public let message: String

    public init(id: Int, level: Level, message: String) {
        self.id = id
        self.level = level
        self.message = message
    }
}

public struct CollabGuestSnapshot: Equatable, Sendable {
    public var phase: CollabConnectionPhase
    public var endedReason: String?
    public var header: JSONValue?
    public var entries: [JSONValue]
    public var state: JSONValue?
    public var agents: [JSONValue]
    public var readOnly: Bool
    public var uiRequest: JSONValue?
    public var notices: [CollabNotice]
    public var lastEvent: JSONValue?

    public init(
        phase: CollabConnectionPhase = .connecting,
        endedReason: String? = nil,
        header: JSONValue? = nil,
        entries: [JSONValue] = [],
        state: JSONValue? = nil,
        agents: [JSONValue] = [],
        readOnly: Bool = false,
        uiRequest: JSONValue? = nil,
        notices: [CollabNotice] = [],
        lastEvent: JSONValue? = nil
    ) {
        self.phase = phase
        self.endedReason = endedReason
        self.header = header
        self.entries = entries
        self.state = state
        self.agents = agents
        self.readOnly = readOnly
        self.uiRequest = uiRequest
        self.notices = notices
        self.lastEvent = lastEvent
    }
}

public struct CollabGuestReplica: Sendable {
    private static let maxNotices = 50

    public private(set) var snapshot: CollabGuestSnapshot
    private var uiRequestQueue: [JSONValue] = []
    private var noticeSequence = 0

    public init(
        phase: CollabConnectionPhase = .connecting
    ) {
        snapshot = CollabGuestSnapshot(phase: phase)
    }

    public mutating func markConnecting() {
        snapshot.phase = .connecting
        snapshot.endedReason = nil
    }

    public mutating func markWaiting() {
        snapshot.phase = .waiting
        snapshot.endedReason = nil
    }

    public mutating func markReconnecting() {
        guard snapshot.phase != .ended else { return }
        snapshot.phase = .reconnecting
    }

    public mutating func end(reason: String) {
        snapshot.phase = .ended
        snapshot.endedReason = reason
        snapshot.uiRequest = nil
        uiRequestQueue.removeAll()
    }

    public mutating func apply(_ frame: CollabHostFrame) {
        switch frame {
        case let .welcome(
            proto,
            header,
            state,
            agents,
            entryCount,
            readOnly
        ):
            if proto != collabProtocolVersion {
                pushNotice(
                    level: .error,
                    message:
                        "protocol mismatch: expected v\(collabProtocolVersion), got v\(proto)"
                )
            }

            snapshot.header = header
            snapshot.entries.removeAll(keepingCapacity: true)
            snapshot.state = state
            snapshot.agents = agents
            snapshot.readOnly = readOnly
            snapshot.uiRequest = nil
            snapshot.lastEvent = nil
            uiRequestQueue.removeAll()
            snapshot.endedReason = nil
            snapshot.phase = entryCount == 0 ? .live : .waiting

        case let .snapshotChunk(entries, final):
            snapshot.entries.append(contentsOf: entries)
            if final {
                snapshot.phase = .live
            } else if snapshot.phase != .ended {
                snapshot.phase = .waiting
            }

        case let .entry(entry):
            snapshot.entries.append(entry)

        case let .event(event):
            snapshot.lastEvent = event

        case let .state(state):
            snapshot.state = state

        case .bus:
            break

        case let .agents(agents):
            snapshot.agents = agents

        case let .uiRequest(request):
            if snapshot.uiRequest == nil {
                snapshot.uiRequest = request
            } else {
                uiRequestQueue.append(request)
            }

        case let .uiRequestEnd(reqId):
            if requestId(snapshot.uiRequest) == reqId {
                showNextUiRequest()
            } else {
                uiRequestQueue.removeAll {
                    requestId($0) == reqId
                }
            }

        case .transcript:
            break

        case let .bye(reason):
            end(reason: reason)

        case let .error(message):
            pushNotice(level: .error, message: message)

        case .unknown:
            break
        }
    }

    public mutating func didAnswerUiRequest(reqId: Int) {
        if requestId(snapshot.uiRequest) == reqId {
            showNextUiRequest()
        }
    }

    private mutating func showNextUiRequest() {
        if uiRequestQueue.isEmpty {
            snapshot.uiRequest = nil
            return
        }
        snapshot.uiRequest = uiRequestQueue.removeFirst()
    }

    private func requestId(_ value: JSONValue?) -> Int? {
        guard let object = value?.objectValue,
              let raw = object["reqId"]?.integerValue,
              let result = Int(exactly: raw)
        else {
            return nil
        }
        return result
    }

    private mutating func pushNotice(
        level: CollabNotice.Level,
        message: String
    ) {
        noticeSequence += 1
        snapshot.notices.append(
            CollabNotice(
                id: noticeSequence,
                level: level,
                message: message
            )
        )

        if snapshot.notices.count > Self.maxNotices {
            snapshot.notices.removeFirst(
                snapshot.notices.count - Self.maxNotices
            )
        }
    }
}
