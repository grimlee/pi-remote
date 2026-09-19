import Foundation

struct ConversationPerformanceReport: Encodable, Sendable {
    let sessionId: String
    let windowStartedAtMs: Int64
    let windowDurationMs: Int
    let displayFrames: Int
    let slowFrames25Ms: Int
    let slowFrames50Ms: Int
    let dragFrames: Int
    let dragSlowFrames25Ms: Int
    let maxFrameGapMs: Int
    let snapshotCount: Int
    let liveCharacters: Int
    let isStreaming: Bool
}
