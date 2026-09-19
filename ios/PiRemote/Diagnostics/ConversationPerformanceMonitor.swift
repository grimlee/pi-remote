import Foundation
import QuartzCore
import UIKit

@MainActor
final class ConversationPerformanceMonitor: NSObject {
    private var displayLink: CADisplayLink?
    private var previousTimestamp: CFTimeInterval?
    private var windowStartedAt = Date()
    private var displayFrames = 0
    private var slowFrames25Ms = 0
    private var slowFrames50Ms = 0
    private var dragFrames = 0
    private var dragSlowFrames25Ms = 0
    private var maxFrameGapMs = 0
    private var snapshotCount = 0
    private var liveCharacters = 0
    private var isStreaming = false
    private var isDragging = false
    private var reporter: ((ConversationPerformanceReport) async -> Void)?

    func start(
        reporter: @escaping (ConversationPerformanceReport) async -> Void
    ) {
        guard displayLink == nil else { return }
        self.reporter = reporter
        resetWindow()

        let link = CADisplayLink(
            target: self,
            selector: #selector(tick(_:))
        )
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
        previousTimestamp = nil
        reporter = nil
        isDragging = false
    }

    func recordSnapshot(
        liveCharacters: Int,
        isStreaming: Bool
    ) {
        snapshotCount += 1
        self.liveCharacters = max(0, liveCharacters)
        self.isStreaming = isStreaming
    }

    func beginDragging() {
        isDragging = true
    }

    func endDragging() {
        isDragging = false
    }

    @objc
    private func tick(_ link: CADisplayLink) {
        defer {
            previousTimestamp = link.timestamp
            maybeFlush()
        }

        guard let previousTimestamp else {
            return
        }

        let delta = link.timestamp - previousTimestamp
        // App background/foreground transitions can create a large artificial
        // gap. Ignore those instead of reporting them as scroll jank.
        guard delta > 0, delta < 1 else {
            return
        }

        let gapMs = Int((delta * 1_000).rounded())
        displayFrames += 1
        maxFrameGapMs = max(maxFrameGapMs, gapMs)

        if gapMs >= 25 {
            slowFrames25Ms += 1
            if isDragging {
                dragSlowFrames25Ms += 1
            }
        }
        if gapMs >= 50 {
            slowFrames50Ms += 1
        }
        if isDragging {
            dragFrames += 1
        }
    }

    private func maybeFlush() {
        let elapsed = Date().timeIntervalSince(windowStartedAt)
        guard elapsed >= 5 else { return }

        let report = ConversationPerformanceReport(
            sessionId: "",
            windowStartedAtMs: Int64(
                windowStartedAt.timeIntervalSince1970 * 1_000
            ),
            windowDurationMs: Int((elapsed * 1_000).rounded()),
            displayFrames: displayFrames,
            slowFrames25Ms: slowFrames25Ms,
            slowFrames50Ms: slowFrames50Ms,
            dragFrames: dragFrames,
            dragSlowFrames25Ms: dragSlowFrames25Ms,
            maxFrameGapMs: maxFrameGapMs,
            snapshotCount: snapshotCount,
            liveCharacters: liveCharacters,
            isStreaming: isStreaming
        )

        let shouldReport = snapshotCount > 0
            || dragFrames > 0
            || slowFrames25Ms > 0

        resetWindow()

        guard shouldReport, let reporter else { return }
        Task {
            await reporter(report)
        }
    }

    private func resetWindow() {
        windowStartedAt = Date()
        displayFrames = 0
        slowFrames25Ms = 0
        slowFrames50Ms = 0
        dragFrames = 0
        dragSlowFrames25Ms = 0
        maxFrameGapMs = 0
        snapshotCount = 0
    }
}
