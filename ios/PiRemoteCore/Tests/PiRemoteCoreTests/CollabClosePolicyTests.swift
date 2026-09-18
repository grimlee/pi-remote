import Testing
@testable import PiRemoteCore

@Test
func collabRelayRoomRecreationClosePolicyMatchesUpstream() {
    #expect(
        CollabRelayClosePolicy.decide(
            code: 4001,
            reason: nil,
            retryMissingRoom: false
        )
        == .retry(retryMissingRoom: true)
    )

    #expect(
        CollabRelayClosePolicy.decide(
            code: 4004,
            reason: nil,
            retryMissingRoom: true
        )
        == .retry(retryMissingRoom: true)
    )

    #expect(
        CollabRelayClosePolicy.decide(
            code: 4004,
            reason: nil,
            retryMissingRoom: false
        )
        == .fatal("no such room")
    )

    #expect(
        CollabRelayClosePolicy.decide(
            code: 4009,
            reason: nil,
            retryMissingRoom: false
        )
        == .fatal("a host is already connected for this room")
    )

    #expect(
        CollabRelayClosePolicy.decide(
            code: 4029,
            reason: nil,
            retryMissingRoom: false
        )
        == .fatal("room is full")
    )

    #expect(
        CollabRelayClosePolicy.decide(
            code: 1006,
            reason: "network lost",
            retryMissingRoom: false
        )
        == .retry(retryMissingRoom: false)
    )
}
