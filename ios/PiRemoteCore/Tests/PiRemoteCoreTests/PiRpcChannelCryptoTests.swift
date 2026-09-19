import Foundation
import Testing
@testable import PiRemoteCore

@Test
func piRpcAADMatchesNodeVector() {
    let aad = PiRpcChannelCrypto.aad(
        machineId: "machine_testvector",
        deviceId: "device_testvector",
        channelId: "rpc_testvector",
        direction: .client,
        seq: 7
    )
    #expect(
        aad.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        == "cGlyZW1vdGUtcGktcnBjLWZyYW1lLXYxAG1hY2hpbmVfdGVzdHZlY3RvcgBkZXZpY2VfdGVzdHZlY3RvcgBycGNfdGVzdHZlY3RvcgBjbGllbnQANw"
    )
}

@Test
func piRpcCapabilityValidatesProtocolAndKey() throws {
    let key = Data(repeating: 0x44, count: 32)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    let raw = """
    {"version":1,"protocol":"piremote-pi-rpc-v1","channelId":"rpc_test","key":"\(key)","nextClientSeq":7,"lastHostSeq":11}
    """
    let capability = try PiRpcCapability.parse(raw)
    #expect(capability.channelId == "rpc_test")
    #expect(capability.nextClientSeq == 7)
    #expect(capability.lastHostSeq == 11)
}
