import Foundation
import Testing
@testable import PiRemoteCore

@Test
func parsesISO8601WithFractionalSeconds() {
    let value = "2026-09-18T15:14:25.475Z"
    let date = PiRemoteDateCoding.parseISO8601(value)
    #expect(date != nil)
}

@Test
func parsesISO8601WithoutFractionalSeconds() {
    let value = "2026-09-18T15:14:25Z"
    let date = PiRemoteDateCoding.parseISO8601(value)
    #expect(date != nil)
}
