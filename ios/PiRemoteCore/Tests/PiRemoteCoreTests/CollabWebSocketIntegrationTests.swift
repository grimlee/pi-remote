import Foundation
import Testing
@testable import PiRemoteCore

private actor CollabIntegrationRecorder {
    private(set) var snapshot = CollabGuestSnapshot()

    func record(_ event: CollabGuestClientEvent) {
        if case let .snapshot(value) = event {
            snapshot = value
        }
    }

    func current() -> CollabGuestSnapshot {
        snapshot
    }
}

private struct CollabIntegrationTimeout: Error {}

private func eventually(
    attempts: Int = 250,
    sleepNanoseconds: UInt64 = 20_000_000,
    _ condition: @escaping () async -> Bool
) async throws {
    for _ in 0..<attempts {
        if await condition() {
            return
        }
        try await Task.sleep(nanoseconds: sleepNanoseconds)
    }
    throw CollabIntegrationTimeout()
}

@Test
func nativeCollabGuestCompletesRealWebSocketRoundTrip() async throws {
    let port = 18_789
    let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
        .appendingPathComponent("mock-collab-relay.mjs")

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [
        "node",
        fixtureURL.path,
        String(port),
    ]

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    try process.run()

    defer {
        if process.isRunning {
            process.terminate()
        }
        process.waitUntilExit()
    }

    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(process.isRunning)

    let roomId = "AQIDBAUGBwgJCgsMDQ4PEA"
    var secret = Data((0..<32).map(UInt8.init))
    secret.append(Data((32..<48).map(UInt8.init)))

    let link =
        "ws://127.0.0.1:"
        + String(port)
        + "/r/"
        + roomId
        + "."
        + secret.base64URLEncodedString()

    let client = try CollabGuestClient(
        link: link,
        displayName: "Pi Remote Integration"
    )
    let recorder = CollabIntegrationRecorder()

    let collector = Task {
        for await event in client.events {
            await recorder.record(event)
        }
    }

    defer {
        collector.cancel()
    }

    await client.connect()

    try await eventually {
        let snapshot = await recorder.current()
        return snapshot.phase == .live
            && snapshot.entries.count == 1
            && snapshot.header?.objectValue?["id"]?.stringValue
                == "integration-session"
    }

    try await client.sendPrompt("integration prompt")

    try await eventually {
        let snapshot = await recorder.current()
        return snapshot.uiRequest?
            .objectValue?["reqId"]?
            .integerValue == 41
    }

    try await client.sendUiResponse(
        reqId: 41,
        value: "yes"
    )

    try await eventually {
        let snapshot = await recorder.current()
        return snapshot.state?
            .objectValue?["isStreaming"]?
            .boolValue == true
    }

    try await client.sendAbort()

    try await eventually {
        let snapshot = await recorder.current()
        return snapshot.phase == .ended
            && snapshot.endedReason == "integration complete"
    }

    let finalSnapshot = await client.currentSnapshot()
    #expect(finalSnapshot.entries.count == 1)
    #expect(finalSnapshot.readOnly == false)

    await client.close()

    try await eventually(
        attempts: 100,
        sleepNanoseconds: 20_000_000
    ) {
        !process.isRunning
    }

    if process.terminationStatus != 0 {
        let errorText = String(
            data: stderr.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        Issue.record(
            "mock Collab relay exited with status \(process.terminationStatus): \(errorText)"
        )
    }
    #expect(process.terminationStatus == 0)
}
