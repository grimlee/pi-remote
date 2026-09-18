import Testing
@testable import PiRemoteCore

private func object(_ values: [String: JSONValue]) -> JSONValue {
    .object(values)
}

@Test
func guestReplicaBuildsSnapshotAndBecomesLiveOnFinalChunk() {
    var replica = CollabGuestReplica()

    replica.apply(
        .welcome(
            proto: 3,
            header: object([
                "type": .string("session"),
                "id": .string("sess-1"),
            ]),
            state: object([
                "isStreaming": .bool(true),
            ]),
            agents: [],
            entryCount: 2,
            readOnly: false
        )
    )

    #expect(replica.snapshot.phase == .waiting)
    #expect(replica.snapshot.entries.isEmpty)

    replica.apply(
        .snapshotChunk(
            entries: [
                object(["type": .string("message"), "id": .string("e1")]),
            ],
            final: false
        )
    )
    #expect(replica.snapshot.phase == .waiting)
    #expect(replica.snapshot.entries.count == 1)

    replica.apply(
        .snapshotChunk(
            entries: [
                object(["type": .string("message"), "id": .string("e2")]),
            ],
            final: true
        )
    )

    #expect(replica.snapshot.phase == .live)
    #expect(replica.snapshot.entries.count == 2)
}

@Test
func guestReplicaFreshWelcomeReplacesStaleReconnectState() {
    var replica = CollabGuestReplica()

    replica.apply(
        .welcome(
            proto: 3,
            header: object(["id": .string("old")]),
            state: object(["isStreaming": .bool(true)]),
            agents: [],
            entryCount: 0,
            readOnly: false
        )
    )
    replica.apply(
        .entry(object(["id": .string("old-entry")]))
    )
    replica.markReconnecting()

    replica.apply(
        .welcome(
            proto: 3,
            header: object(["id": .string("new")]),
            state: object(["isStreaming": .bool(false)]),
            agents: [],
            entryCount: 0,
            readOnly: true
        )
    )

    #expect(replica.snapshot.phase == .live)
    #expect(replica.snapshot.header?.objectValue?["id"]?.stringValue == "new")
    #expect(replica.snapshot.entries.isEmpty)
    #expect(replica.snapshot.readOnly)
}

@Test
func guestReplicaQueuesAndEndsUiRequestsLikeUpstreamClient() {
    var replica = CollabGuestReplica(phase: .live)

    replica.apply(
        .uiRequest(
            object([
                "kind": .string("select"),
                "reqId": .integer(1),
            ])
        )
    )
    replica.apply(
        .uiRequest(
            object([
                "kind": .string("editor"),
                "reqId": .integer(2),
            ])
        )
    )

    #expect(
        replica.snapshot.uiRequest?.objectValue?["reqId"]?.integerValue == 1
    )

    replica.apply(.uiRequestEnd(reqId: 1))

    #expect(
        replica.snapshot.uiRequest?.objectValue?["reqId"]?.integerValue == 2
    )

    replica.didAnswerUiRequest(reqId: 2)
    #expect(replica.snapshot.uiRequest == nil)
}

@Test
func guestReplicaRetainsRawUnknownEventsWithoutBreakingSnapshot() {
    var replica = CollabGuestReplica(phase: .live)
    let event = object([
        "type": .string("future-event"),
        "payload": .integer(42),
    ])

    replica.apply(.event(event))

    #expect(replica.snapshot.phase == .live)
    #expect(replica.snapshot.lastEvent == event)

    replica.apply(
        .unknown(
            type: "future-frame",
            raw: object(["t": .string("future-frame")])
        )
    )

    #expect(replica.snapshot.phase == .live)
    #expect(replica.snapshot.lastEvent == event)
}
