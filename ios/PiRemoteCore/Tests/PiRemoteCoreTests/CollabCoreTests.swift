import Foundation
import Testing
@testable import PiRemoteCore

@Test
func collabLinkParsesViewAndControlCapabilities() throws {
    let roomId = "AQIDBAUGBwgJCgsMDQ4PEA"
    let key = Data((0..<32).map(UInt8.init))
    let token = Data((32..<48).map(UInt8.init))

    let view = try CollabLinkParser.parse(
        roomId + "." + key.base64URLEncodedString()
    )
    #expect(view.webSocketURL.absoluteString == "wss://my.omp.sh/r/" + roomId)
    #expect(view.roomId == roomId)
    #expect(view.roomKey == key)
    #expect(view.writeToken == nil)
    #expect(view.isReadOnly)

    var fullSecret = key
    fullSecret.append(token)
    let control = try CollabLinkParser.parse(
        "relay.example.com:8443/r/"
            + roomId
            + "."
            + fullSecret.base64URLEncodedString()
    )
    #expect(
        control.webSocketURL.absoluteString
            == "wss://relay.example.com:8443/r/" + roomId
    )
    #expect(control.roomKey == key)
    #expect(control.writeToken == token)
    #expect(!control.isReadOnly)
}

@Test
func collabLinkParsesBrowserWrapperAndLegacyFragment() throws {
    let roomId = "AQIDBAUGBwgJCgsMDQ4PEA"
    let key = Data((0..<32).map(UInt8.init))
    let keyText = key.base64URLEncodedString()

    let wrapped = try CollabLinkParser.parse(
        "https://web.example/collab/#"
            + "relay.example.com:8443/r/"
            + roomId
            + "."
            + keyText
    )
    #expect(
        wrapped.webSocketURL.absoluteString
            == "wss://relay.example.com:8443/r/" + roomId
    )

    let legacy = try CollabLinkParser.parse(
        "https://my.omp.sh/#" + roomId + "%23" + keyText
    )
    #expect(
        legacy.webSocketURL.absoluteString
            == "wss://my.omp.sh/r/" + roomId
    )
    #expect(legacy.roomKey == key)
}

@Test
func collabLinkRejectsInsecureRemoteRelayAndWrongSecretLength() throws {
    let roomId = "AQIDBAUGBwgJCgsMDQ4PEA"
    let key = Data((0..<32).map(UInt8.init))
    let keyText = key.base64URLEncodedString()

    #expect(throws: CollabLinkError.insecureRemoteRelay) {
        try CollabLinkParser.parse(
            "ws://relay.example.com/r/" + roomId + "." + keyText
        )
    }

    let bad = Data(repeating: 7, count: 40).base64URLEncodedString()
    #expect(throws: CollabLinkError.invalidSecretLength(40)) {
        try CollabLinkParser.parse(roomId + "." + bad)
    }
}

@Test
func collabEnvelopeMatchesUpstreamBigEndianLayout() throws {
    let envelope = CollabEnvelope(
        peerId: 0xDEADBEEF,
        payload: Data([1, 2, 3, 250])
    )
    let encoded = envelope.encoded()

    #expect(
        encoded == Data([0xDE, 0xAD, 0xBE, 0xEF, 1, 2, 3, 250])
    )
    #expect(try CollabEnvelope.decode(encoded) == envelope)
}

@Test
func collabAESGCMVectorMatchesUpstreamWebCryptoLayout() throws {
    let key = Data((0..<32).map(UInt8.init))
    let nonce = Data((0..<12).map(UInt8.init))
    let plaintext = Data(
        #"{"t":"hello","proto":3,"name":"Pi Remote","writeToken":"AQID"}"#.utf8
    )

    let sealed = try CollabCodec.sealForTest(
        plaintext,
        roomKey: key,
        nonceData: nonce
    )

    #expect(
        sealed.base64URLEncodedString()
            == "AAECAwQFBgcICQoLPCCiOf_Hqn7hLfipncsIH-yi6BbKSHNeVgaI4D9TIuJoMPyZwq5m_VaIXZr67lxdujYL6DT0mfh-xmNdOp5jODGPSwgKav0dZezZhzkm"
    )

    #expect(try CollabCodec.open(sealed, roomKey: key) == plaintext)
}

@Test
func collabHostWelcomeVectorDecryptsAndDecodes() throws {
    let key = Data((0..<32).map(UInt8.init))
    let sealed = try #require(
        Data(
            base64URLEncoded:
                "AAECAwQFBgcICQoLPCCiOf_HtX7hIvjm1MtUT_Ok6ECfWWVPFEWN4HwNZcAjKtXe27hi_VaeXZ7t9FtRgTdCoXi_x_gFtVk7NMGBh51ZtQ6yvFZDJnaYXt25I9gBp_haIlNjUs3NpPxIqpuh6ZsugoZ76jXqcU6QNVkDDM4GFs7B_164JIwEufCDD2PSPGfkjrGqP3uEZINMrym3U5CuUEZi8i3pHIcClKbL1KO7vHaem-5EhUypl6-iqpntr7hW4sgazASxtLRT_-yubmCom2q4uL1EdOm952374Y8Kig9-b8-fBbOg9zw6o5uFpzr33kZvQDJVGJCl"
        )
    )

    let frame = try CollabCodec.openHostFrame(
        sealed,
        roomKey: key
    )

    guard case let .welcome(
        proto,
        header,
        state,
        agents,
        entryCount,
        readOnly
    ) = frame else {
        Issue.record("Expected welcome frame")
        return
    }

    #expect(proto == 3)
    #expect(entryCount == 0)
    #expect(!readOnly)
    #expect(agents.isEmpty)
    #expect(header.objectValue?["id"]?.stringValue == "s")
    #expect(state.objectValue?["isStreaming"]?.boolValue == false)
}

@Test
func collabGuestHelloEncodesProtocolThreeAndWriteToken() throws {
    let data = try CollabFrameJSON.encodeGuest(
        .hello(
            name: "Pi Remote",
            writeToken: "AQID"
        )
    )
    let raw = try JSONDecoder().decode(JSONValue.self, from: data)
    let object = try #require(raw.objectValue)

    #expect(object["t"]?.stringValue == "hello")
    #expect(object["proto"]?.integerValue == 3)
    #expect(object["name"]?.stringValue == "Pi Remote")
    #expect(object["writeToken"]?.stringValue == "AQID")
}

@Test
func collabUnknownHostFrameIsForwardCompatible() throws {
    let frame = try CollabFrameJSON.decodeHost(
        Data(#"{"t":"future-frame","x":1}"#.utf8)
    )

    guard case let .unknown(type, raw) = frame else {
        Issue.record("Expected unknown host frame")
        return
    }

    #expect(type == "future-frame")
    #expect(raw.objectValue?["x"]?.integerValue == 1)
}
