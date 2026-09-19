import Foundation
import PiRemoteCore

actor RelayClient {
    enum Event: Sendable {
        case machinesSnapshot([RemoteMachine])
        case machinePresence(machineId: String, online: Bool)
        case rpcFrame(PiRpcRelayFrame)
        case transportClosed(String)
    }

    enum RelayError: LocalizedError, Sendable {
        case notConnected
        case invalidFrame
        case authenticationFailed
        case missingMachineGrant
        case invalidCapability
        case invalidPairingAcceptance
        case remote(code: String, message: String)

        var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Pi Remote Relay is not connected."
            case .invalidFrame:
                return "Pi Remote Relay returned an invalid frame."
            case .authenticationFailed:
                return "Pi Remote Relay authentication failed."
            case .missingMachineGrant:
                return "No trusted MachineGrant matches the selected host identity."
            case .invalidCapability:
                return "The encrypted Pi session capability did not match the requested session."
            case .invalidPairingAcceptance:
                return "The host pairing acceptance could not be verified."
            case let .remote(_, message):
                return message
            }
        }
    }

    struct Configuration: Sendable {
        let url: URL
        let deviceName: String

        init(url: URL, deviceName: String = "iPhone") {
            self.url = url
            self.deviceName = deviceName
        }
    }

    private struct FrameHeader: Decodable {
        let protocolVersion: Int
        let type: String
    }

    private struct AuthResponse: Encodable, Sendable {
        let protocolVersion = 0
        let type = "auth.response"
        let challengeId: String
        let principal: RelayAuthPrincipal
        let signature: String
    }

    private struct AuthAccepted: Decodable {
        let protocolVersion: Int
        let type: String
        let principal: RelayAuthPrincipal
    }

    private struct ClientHello: Encodable, Sendable {
        let protocolVersion = 0
        let type = "client.hello"
        let device: DevicePublicIdentity
    }

    private struct ClientAuthorizations: Encodable, Sendable {
        let protocolVersion = 0
        let type = "client.authorizations"
        let grants: [MachineGrant]
    }


    private struct PairingRequestDevice: Encodable, Sendable {
        let id: String
        let name: String
        let signingPublicKey: String
        let keyAgreementPublicKey: String
    }

    private struct PairingRequestBody: Encodable, Sendable {
        let version = 1
        let pairingId: String
        let machineId: String
        let device: PairingRequestDevice
        let proof: String
        let deviceSignature: String
    }

    private struct PairingTarget: Encodable, Sendable {
        let id: String
        let signingPublicKey: String
    }

    private struct PairingRequestFrame: Encodable, Sendable {
        let protocolVersion = 0
        let type = "pairing.request"
        let requestId: String
        let machine: PairingTarget
        let pairing: PairingRequestBody
    }

    private struct PairingResponseFrame: Decodable {
        let protocolVersion: Int
        let type: String
        let requestId: String
        let machineId: String
        let ok: Bool
        let acceptance: PairingAcceptance?
        let error: RemoteError?
    }

    private struct MachinesSnapshotFrame: Decodable {
        let protocolVersion: Int
        let type: String
        let machines: [RemoteMachine]
    }

    private struct MachinePresenceFrame: Decodable {
        let protocolVersion: Int
        let type: String
        let machineId: String
        let online: Bool
    }

    private struct ControlAuthorization: Encodable, Sendable {
        let deviceId: String
        let issuedAtMs: Int64
        let signature: String
    }

    private struct ControlRequest<Payload: Encodable & Sendable>: Encodable, Sendable {
        let protocolVersion = 0
        let type = "control.request"
        let requestId: String
        let machineId: String
        let payload: Payload
        let authorization: ControlAuthorization
    }

    private struct SessionsListPayload: Encodable, Sendable {
        let op = "sessions.list"
    }

    private struct SessionsLinkPayload: Encodable, Sendable {
        let op = "sessions.link"
        let instanceId: String
        let generation: Int
        let access: RemoteSession.Access
        let resumeFromHostSeq: Int64?
    }

    private struct DiagnosticsReportPayload: Encodable, Sendable {
        let op = "diagnostics.report"
        let report: ConversationPerformanceReport
    }

    private struct SessionsListResponsePayload: Decodable {
        let op: String
        let sessions: [RemoteSession]
    }

    private struct SessionsLinkResponsePayload: Decodable {
        let op: String
        let instanceId: String
        let generation: Int
        let access: RemoteSession.Access
        let capability: EncryptedCollabCapability
    }

    private struct RemoteError: Decodable {
        let code: String
        let message: String
    }

    private struct ControlResponse<Payload: Decodable>: Decodable {
        let protocolVersion: Int
        let type: String
        let requestId: String
        let machineId: String
        let ok: Bool
        let payload: Payload?
        let error: RemoteError?
    }

    private let configuration: Configuration
    private let identityStore: DeviceIdentityStore
    private let grantStore: MachineGrantStore
    private let onEvent: @Sendable (Event) async -> Void
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private struct PendingPairing {
        let continuation: CheckedContinuation<PairingAcceptance, Error>
        let invitation: PairingInvitation
        let device: DevicePublicIdentity
    }

    private struct PendingSessionLink {
        let continuation: CheckedContinuation<SessionLink, Error>
        let machine: RemoteMachine
        let deviceId: String
        let instanceId: String
        let generation: Int
        let access: RemoteSession.Access
    }

    private var authenticatedDevice: DevicePublicIdentity?
    private var pendingPairings: [String: PendingPairing] = [:]
    private var pendingSessionLists: [String: CheckedContinuation<[RemoteSession], Error>] = [:]
    private var pendingSessionLinks: [String: PendingSessionLink] = [:]

    init(
        configuration: Configuration,
        identityStore: DeviceIdentityStore = DeviceIdentityStore(),
        grantStore: MachineGrantStore = MachineGrantStore(),
        onEvent: @escaping @Sendable (Event) async -> Void
    ) {
        self.configuration = configuration
        self.identityStore = identityStore
        self.grantStore = grantStore
        self.onEvent = onEvent
        self.session = URLSession(configuration: .default)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = PiRemoteDateCoding.parseISO8601(value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Invalid ISO-8601 date: \(value)"
                )
            }
            return date
        }
        self.decoder = decoder
    }

    func connect() async throws {
        disconnect()

        let socket = session.webSocketTask(with: configuration.url)
        self.socket = socket
        socket.resume()

        do {
            let challengeData = try await receiveData(from: socket)
            let challenge = try decoder.decode(RelayAuthChallenge.self, from: challengeData)
            guard challenge.protocolVersion == 0,
                  challenge.type == "auth.challenge",
                  challenge.role == .client
            else {
                throw RelayError.authenticationFailed
            }

            let identity = try await identityStore.loadOrCreate(
                deviceName: configuration.deviceName
            )
            let principal = RelayAuthPrincipal(
                kind: .device,
                id: identity.id,
                signingPublicKey: identity.signingPublicKey
            )
            let authMessage = RelayAuthCrypto.message(
                challenge: challenge,
                principal: principal
            )
            let signature = try await identityStore.signature(for: authMessage)
                .base64URLEncodedString()

            try await send(
                AuthResponse(
                    challengeId: challenge.challengeId,
                    principal: principal,
                    signature: signature
                )
            )

            let acceptedData = try await receiveData(from: socket)
            let accepted = try decoder.decode(AuthAccepted.self, from: acceptedData)
            guard accepted.protocolVersion == 0,
                  accepted.type == "auth.accepted",
                  accepted.principal == principal
            else {
                throw RelayError.authenticationFailed
            }

            authenticatedDevice = identity
            try await send(ClientHello(device: identity))

            let grants = try await grantStore.all(for: identity)
            try await send(ClientAuthorizations(grants: grants))

            receiveTask = Task { [weak self] in
                await self?.receiveLoop()
            }
        } catch {
            socket.cancel(with: .policyViolation, reason: nil)
            self.socket = nil
            authenticatedDevice = nil
            throw error
        }
    }

    func isConnected() -> Bool {
        guard authenticatedDevice != nil,
              let socket,
              receiveTask != nil
        else {
            return false
        }
        return socket.state == .running
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        authenticatedDevice = nil

        let error = CancellationError()
        for pending in pendingPairings.values {
            pending.continuation.resume(throwing: error)
        }
        pendingPairings.removeAll()

        for continuation in pendingSessionLists.values {
            continuation.resume(throwing: error)
        }
        pendingSessionLists.removeAll()

        for pending in pendingSessionLinks.values {
            pending.continuation.resume(throwing: error)
        }
        pendingSessionLinks.removeAll()
    }


    func pair(using bootstrap: PairingBootstrap) async throws -> PairingAcceptance {
        guard let device = authenticatedDevice else {
            throw RelayError.authenticationFailed
        }

        let invitation = bootstrap.invitation
        let message = PairingCrypto.requestMessage(
            pairingId: invitation.pairingId,
            machineId: invitation.machine.id,
            device: device
        )
        let proof = try PairingCrypto.proof(
            secretBase64URL: invitation.secret,
            message: message
        )
        let deviceSignature = try await identityStore.signature(for: message)
            .base64URLEncodedString()
        let requestId = UUID().uuidString

        let request = PairingRequestFrame(
            requestId: requestId,
            machine: PairingTarget(
                id: invitation.machine.id,
                signingPublicKey: invitation.machine.signingPublicKey
            ),
            pairing: PairingRequestBody(
                pairingId: invitation.pairingId,
                machineId: invitation.machine.id,
                device: PairingRequestDevice(
                    id: device.id,
                    name: device.name,
                    signingPublicKey: device.signingPublicKey,
                    keyAgreementPublicKey: device.keyAgreementPublicKey
                ),
                proof: proof,
                deviceSignature: deviceSignature
            )
        )

        return try await withCheckedThrowingContinuation { continuation in
            pendingPairings[requestId] = PendingPairing(
                continuation: continuation,
                invitation: invitation,
                device: device
            )
            Task { [weak self] in
                do {
                    try await self?.send(request)
                } catch {
                    await self?.failPairing(
                        requestId: requestId,
                        error: error
                    )
                }
            }
        }
    }

    func listSessions(machineId: String) async throws -> [RemoteSession] {
        guard let device = authenticatedDevice else {
            throw RelayError.authenticationFailed
        }

        let requestId = UUID().uuidString
        let issuedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        let message = ControlRequestCrypto.sessionsListMessage(
            requestId: requestId,
            machineId: machineId,
            deviceId: device.id,
            issuedAtMs: issuedAtMs
        )
        let signature = try await identityStore.signature(for: message)
            .base64URLEncodedString()

        let request = ControlRequest(
            requestId: requestId,
            machineId: machineId,
            payload: SessionsListPayload(),
            authorization: ControlAuthorization(
                deviceId: device.id,
                issuedAtMs: issuedAtMs,
                signature: signature
            )
        )

        return try await withCheckedThrowingContinuation { continuation in
            pendingSessionLists[requestId] = continuation
            Task { [weak self] in
                do {
                    try await self?.send(request)
                } catch {
                    await self?.failSessionList(requestId: requestId, error: error)
                }
            }
        }
    }

    func requestSessionLink(
        machine: RemoteMachine,
        instanceId: String,
        generation: Int,
        access: RemoteSession.Access,
        resumeFromHostSeq: Int64? = nil
    ) async throws -> SessionLink {
        guard let device = authenticatedDevice else {
            throw RelayError.authenticationFailed
        }

        guard try await grantStore.grant(
            machineId: machine.id,
            signingPublicKey: machine.signingPublicKey,
            keyAgreementPublicKey: machine.keyAgreementPublicKey,
            for: device
        ) != nil else {
            throw RelayError.missingMachineGrant
        }

        let requestId = UUID().uuidString
        let issuedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        let message = ControlRequestCrypto.sessionsLinkMessage(
            requestId: requestId,
            machineId: machine.id,
            deviceId: device.id,
            issuedAtMs: issuedAtMs,
            instanceId: instanceId,
            generation: generation,
            access: access.rawValue,
            resumeFromHostSeq: resumeFromHostSeq
        )
        let signature = try await identityStore.signature(for: message)
            .base64URLEncodedString()

        let request = ControlRequest(
            requestId: requestId,
            machineId: machine.id,
            payload: SessionsLinkPayload(
                instanceId: instanceId,
                generation: generation,
                access: access,
                resumeFromHostSeq: resumeFromHostSeq
            ),
            authorization: ControlAuthorization(
                deviceId: device.id,
                issuedAtMs: issuedAtMs,
                signature: signature
            )
        )

        return try await withCheckedThrowingContinuation { continuation in
            pendingSessionLinks[requestId] = PendingSessionLink(
                continuation: continuation,
                machine: machine,
                deviceId: device.id,
                instanceId: instanceId,
                generation: generation,
                access: access
            )
            Task { [weak self] in
                do {
                    try await self?.send(request)
                } catch {
                    await self?.failSessionLink(requestId: requestId, error: error)
                }
            }
        }
    }

    func sendDiagnostics(
        machineId: String,
        report: ConversationPerformanceReport
    ) async throws {
        guard let device = authenticatedDevice else {
            throw RelayError.authenticationFailed
        }

        let requestId = UUID().uuidString
        let issuedAtMs = Int64(Date().timeIntervalSince1970 * 1_000)
        let message = ControlRequestCrypto.diagnosticsReportMessage(
            requestId: requestId,
            machineId: machineId,
            deviceId: device.id,
            issuedAtMs: issuedAtMs,
            sessionId: report.sessionId,
            windowStartedAtMs: report.windowStartedAtMs,
            windowDurationMs: report.windowDurationMs,
            displayFrames: report.displayFrames,
            slowFrames25Ms: report.slowFrames25Ms,
            slowFrames50Ms: report.slowFrames50Ms,
            dragFrames: report.dragFrames,
            dragSlowFrames25Ms: report.dragSlowFrames25Ms,
            maxFrameGapMs: report.maxFrameGapMs,
            snapshotCount: report.snapshotCount,
            liveCharacters: report.liveCharacters,
            isStreaming: report.isStreaming
        )
        let signature = try await identityStore.signature(for: message)
            .base64URLEncodedString()

        let request = ControlRequest(
            requestId: requestId,
            machineId: machineId,
            payload: DiagnosticsReportPayload(
                report: report
            ),
            authorization: ControlAuthorization(
                deviceId: device.id,
                issuedAtMs: issuedAtMs,
                signature: signature
            )
        )

        try await send(request)
    }

    func sendRpcFrame(_ frame: PiRpcRelayFrame) async throws {
        guard frame.direction == .client else {
            throw RelayError.invalidFrame
        }
        try await send(frame)
    }

    private func send<T: Encodable & Sendable>(_ frame: T) async throws {
        guard let socket else { throw RelayError.notConnected }
        let data = try encoder.encode(frame)
        try await socket.send(.data(data))
    }

    private func receiveData(
        from socket: URLSessionWebSocketTask
    ) async throws -> Data {
        let message = try await socket.receive()
        switch message {
        case let .data(value):
            return value
        case let .string(value):
            guard let data = value.data(using: .utf8) else {
                throw RelayError.invalidFrame
            }
            return data
        @unknown default:
            throw RelayError.invalidFrame
        }
    }

    private func receiveLoop() async {
        while !Task.isCancelled, let socket {
            do {
                let data = try await receiveData(from: socket)
                try await handle(data)
            } catch {
                if !Task.isCancelled {
                    failAllPending(error)
                    self.socket = nil
                    authenticatedDevice = nil
                    receiveTask = nil
                    await onEvent(
                        .transportClosed(
                            error.localizedDescription
                        )
                    )
                }
                return
            }
        }
    }

    private func handle(_ data: Data) async throws {
        let header = try decoder.decode(FrameHeader.self, from: data)
        guard header.protocolVersion == 0 else { throw RelayError.invalidFrame }

        switch header.type {
        case "pairing.response":
            try await handlePairingResponse(data)

        case "machines.snapshot":
            let frame = try decoder.decode(MachinesSnapshotFrame.self, from: data)
            await onEvent(.machinesSnapshot(frame.machines))

        case "machine.presence":
            let frame = try decoder.decode(MachinePresenceFrame.self, from: data)
            await onEvent(.machinePresence(machineId: frame.machineId, online: frame.online))

        case "control.response":
            try await handleControlResponse(data)

        case "rpc.frame":
            let frame = try decoder.decode(PiRpcRelayFrame.self, from: data)
            guard frame.direction == .host else {
                throw RelayError.invalidFrame
            }
            await onEvent(.rpcFrame(frame))

        default:
            break
        }
    }


    private func handlePairingResponse(_ data: Data) async throws {
        struct ResponseHeader: Decodable {
            let requestId: String
        }

        let header = try decoder.decode(ResponseHeader.self, from: data)
        guard let pending = pendingPairings.removeValue(
            forKey: header.requestId
        ) else {
            return
        }

        let response = try decoder.decode(
            PairingResponseFrame.self,
            from: data
        )
        guard response.protocolVersion == 0,
              response.type == "pairing.response",
              response.ok,
              response.machineId == pending.invitation.machine.id,
              let acceptance = response.acceptance
        else {
            let remote = response.error
            pending.continuation.resume(
                throwing: RelayError.remote(
                    code: remote?.code ?? "pairing_failed",
                    message: remote?.message ?? "The host rejected pairing."
                )
            )
            return
        }

        guard PairingAcceptanceCrypto.verify(
            acceptance,
            invitation: pending.invitation,
            device: pending.device
        ) else {
            pending.continuation.resume(
                throwing: RelayError.invalidPairingAcceptance
            )
            return
        }

        do {
            try await grantStore.save(
                acceptance.grant,
                for: pending.device
            )
            let grants = try await grantStore.all(for: pending.device)
            try await send(ClientAuthorizations(grants: grants))
            pending.continuation.resume(returning: acceptance)
        } catch {
            pending.continuation.resume(throwing: error)
        }
    }

    private func handleControlResponse(_ data: Data) async throws {
        struct ResponseHeader: Decodable {
            let requestId: String
        }

        let header = try decoder.decode(ResponseHeader.self, from: data)

        if let continuation = pendingSessionLists[header.requestId] {
            do {
                let response = try decoder.decode(
                    ControlResponse<SessionsListResponsePayload>.self,
                    from: data
                )
                pendingSessionLists.removeValue(forKey: header.requestId)

                guard response.ok, let payload = response.payload else {
                    let error = response.error
                    continuation.resume(
                        throwing: RelayError.remote(
                            code: error?.code ?? "internal_error",
                            message: error?.message ?? "The host rejected the request."
                        )
                    )
                    return
                }

                continuation.resume(returning: payload.sessions)
            } catch {
                pendingSessionLists.removeValue(forKey: header.requestId)
                continuation.resume(
                    throwing: RelayError.remote(
                        code: "decode_error",
                        message: "Could not decode the Host session list: \(String(describing: error))"
                    )
                )
            }
            return
        }

        if let pending = pendingSessionLinks[header.requestId] {
            let response: ControlResponse<SessionsLinkResponsePayload>
            do {
                response = try decoder.decode(
                    ControlResponse<SessionsLinkResponsePayload>.self,
                    from: data
                )
                pendingSessionLinks.removeValue(forKey: header.requestId)
            } catch {
                pendingSessionLinks.removeValue(forKey: header.requestId)
                pending.continuation.resume(
                    throwing: RelayError.remote(
                        code: "decode_error",
                        message: "Could not decode the Host session capability: \(String(describing: error))"
                    )
                )
                return
            }
            guard response.ok, let payload = response.payload else {
                let error = response.error
                pending.continuation.resume(
                    throwing: RelayError.remote(
                        code: error?.code ?? "internal_error",
                        message: error?.message ?? "The host rejected the request."
                    )
                )
                return
            }

            let capability = payload.capability
            guard response.machineId == pending.machine.id,
                  payload.op == "sessions.link",
                  payload.instanceId == pending.instanceId,
                  payload.generation == pending.generation,
                  payload.access == pending.access,
                  capability.machineId == pending.machine.id,
                  capability.deviceId == pending.deviceId,
                  capability.requestId == header.requestId,
                  capability.instanceId == pending.instanceId,
                  capability.generation == pending.generation,
                  capability.access == pending.access.rawValue
            else {
                pending.continuation.resume(throwing: RelayError.invalidCapability)
                throw RelayError.invalidCapability
            }

            do {
                let collabUrl = try await identityStore.decryptCollabCapability(
                    capability,
                    machineKeyAgreementPublicKey: pending.machine.keyAgreementPublicKey
                )
                pending.continuation.resume(
                    returning: SessionLink(
                        instanceId: payload.instanceId,
                        generation: payload.generation,
                        access: payload.access,
                        collabUrl: collabUrl
                    )
                )
            } catch {
                pending.continuation.resume(throwing: error)
                throw error
            }
        }
    }

    private func failPairing(requestId: String, error: Error) {
        pendingPairings.removeValue(forKey: requestId)?
            .continuation
            .resume(throwing: error)
    }

    private func failSessionList(requestId: String, error: Error) {
        pendingSessionLists.removeValue(forKey: requestId)?.resume(throwing: error)
    }

    private func failSessionLink(requestId: String, error: Error) {
        pendingSessionLinks.removeValue(forKey: requestId)?
            .continuation
            .resume(throwing: error)
    }

    private func failAllPending(_ error: Error) {
        for pending in pendingPairings.values {
            pending.continuation.resume(throwing: error)
        }
        pendingPairings.removeAll()

        for continuation in pendingSessionLists.values {
            continuation.resume(throwing: error)
        }
        pendingSessionLists.removeAll()

        for pending in pendingSessionLinks.values {
            pending.continuation.resume(throwing: error)
        }
        pendingSessionLinks.removeAll()
    }
}
