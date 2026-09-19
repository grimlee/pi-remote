import Foundation
import Observation
import PiRemoteCore

@Observable
@MainActor
final class AppStore {
    enum ConnectionState: Equatable {
        case unpaired
        case connecting
        case connected(hostName: String)
        case disconnected
    }

    enum StoreError: LocalizedError {
        case expiredPairingPayload
        case invalidRelayURL
        case noTrustedMachine

        var errorDescription: String? {
            switch self {
            case .expiredPairingPayload:
                return "The pairing payload has expired. Create a new one on the host."
            case .invalidRelayURL:
                return "The pairing payload contains an invalid relay URL."
            case .noTrustedMachine:
                return "The trusted host is not currently available through the relay."
            }
        }
    }

    var connectionState: ConnectionState = .unpaired
    var machines: [RemoteMachine] = []
    var sessions: [RemoteSession] = []
    var selectedSessionID: String?
    var rpcSnapshot: PiRpcSnapshot?
    var pairingPayload = ""
    var composerText = ""
    var pairingError: String?
    var sessionError: String?
    var isPairing = false
    var isOpeningSession = false
    var isResumingSession = false
    var isCreatingSession = false
    private let identityStore = DeviceIdentityStore()
    private let grantStore = MachineGrantStore()
    private let profileStore = PairedHostProfileStore()
    private let conversationCache = ConversationCacheStore()
    private let tailcatTransport = TailcatTransport()

    private var profile: PairedHostProfile?
    private var relayClient: RelayClient?
    private var rpcClient: PiRpcClient?
    private var rpcEventsTask: Task<Void, Never>?
    private var started = false
    private var needsSessionRestore = false
    private var needsRpcTransportResume = false
    private var resumeInFlight = false
    private var relayConnectInFlight = false
    private var activeMachine: RemoteMachine?
    private var activeCacheSessionId: String?
    private var lastCachedMessageRevision = 0
    private var shouldRefreshAfterNewSession = false
    private var backgroundedAt: Date?
    private let backgroundGraceInterval: TimeInterval = 3 * 60

    func start() async {
        guard !started else { return }
        started = true

        do {
            guard let stored = try await profileStore.load() else {
                connectionState = .unpaired
                return
            }
            profile = stored
            try await connectRelay(profile: stored)
        } catch {
            connectionState = .disconnected
            sessionError = error.localizedDescription
        }
    }

    func pairFromPayload() async {
        guard !isPairing else { return }
        isPairing = true
        pairingError = nil
        sessionError = nil

        do {
            let bootstrap = try PairingBootstrap.parse(pairingPayload)
            guard let expiresAt = Self.parseISO8601(
                bootstrap.invitation.expiresAt
            ), expiresAt > Date() else {
                throw StoreError.expiredPairingPayload
            }
            await disconnectRelayAndRpc()

            let relayURL = try await resolveRelayURL(
                relayURL: bootstrap.relayUrl,
                transport: bootstrap.transport
            )

            let client = makeRelayClient(url: relayURL)
            relayClient = client
            connectionState = .connecting
            try await client.connect()

            let acceptance = try await client.pair(using: bootstrap)
            let pairedProfile = PairedHostProfile(
                relayURL: bootstrap.relayUrl,
                transport: bootstrap.transport,
                machine: acceptance.machine
            )
            try await profileStore.save(pairedProfile)
            profile = pairedProfile
            pairingPayload = ""
            connectionState = .connected(
                hostName: acceptance.machine.name
            )
        } catch {
            await tailcatTransport.stop()
            pairingError = error.localizedDescription
            connectionState = profile == nil ? .unpaired : .disconnected
        }

        isPairing = false
    }

    func refreshSessions() async {
        guard let machine = activeMachine,
              let relayClient
        else {
            return
        }

        sessionError = nil

        do {
            let values = try await relayClient.listSessions(
                machineId: machine.id
            )
            sessions = values
                .sorted { $0.startedAt > $1.startedAt }
            sessionError = nil

            if let selectedSessionID,
               let session = sessions.first(
                where: { $0.instanceId == selectedSessionID }
               ) {
                if needsRpcTransportResume {
                    await resumeSessionTransport(session)
                } else if needsSessionRestore {
                    needsSessionRestore = false
                    await openSession(session)
                }
            }
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func openSession(_ session: RemoteSession) async {
        guard !isOpeningSession else { return }
        guard let machine = activeMachine,
              let relayClient
        else {
            sessionError = StoreError.noTrustedMachine.localizedDescription
            return
        }

        isOpeningSession = true
        isResumingSession = false
        sessionError = nil
        selectedSessionID = session.instanceId
        needsSessionRestore = false
        needsRpcTransportResume = false

        await closeRpc()
        activeCacheSessionId = session.sessionId
        lastCachedMessageRevision = 0

        let cachedMessages = (
            try? await conversationCache.load(
                machineId: machine.id,
                sessionId: session.sessionId
            )
        ) ?? []

        rpcSnapshot = PiRpcSnapshot(
            phase: .connecting,
            messages: cachedMessages
        )

        do {
            let link = try await requestSessionLinkWithRefresh(
                relayClient: relayClient,
                machine: machine,
                session: session
            )
            let device = try await identityStore.publicIdentity()
            let client = try PiRpcClient(
                capabilityString: link.collabUrl,
                machineId: machine.id,
                deviceId: device.id,
                initialMessages: cachedMessages
            ) { frame in
                try await relayClient.sendRpcFrame(frame)
            }

            rpcClient = client

            rpcEventsTask = Task { [weak self] in
                for await event in client.events {
                    await self?.handleRpcEvent(event)
                }
            }

            try await client.start()
        } catch {
            sessionError = error.localizedDescription
            rpcClient = nil

            if cachedMessages.isEmpty {
                rpcSnapshot = nil
            } else {
                rpcSnapshot = PiRpcSnapshot(
                    phase: .closed,
                    messages: cachedMessages
                )
            }
        }

        isOpeningSession = false
    }

    private func requestSessionLinkWithRefresh(
        relayClient: RelayClient,
        machine: RemoteMachine,
        session: RemoteSession
    ) async throws -> SessionLink {
        do {
            return try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: session.instanceId,
                generation: session.generation,
                access: session.access
            )
        } catch let error as RelayClient.RelayError {
            guard case let .remote(code, _) = error,
                  code == "stale_generation"
            else {
                throw error
            }

            let refreshed = try await relayClient.listSessions(
                machineId: machine.id
            )
            let sorted = refreshed.sorted {
                $0.startedAt > $1.startedAt
            }
            sessions = sorted

            guard let current = sorted.first(
                where: {
                    $0.instanceId == session.instanceId
                }
            ) else {
                throw error
            }

            return try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: current.instanceId,
                generation: current.generation,
                access: current.access
            )
        }
    }

    func createNewSession(from bootstrap: RemoteSession) async {
        guard !isOpeningSession, !isCreatingSession else { return }
        guard let machine = activeMachine,
              let relayClient
        else {
            sessionError = StoreError.noTrustedMachine.localizedDescription
            return
        }

        isCreatingSession = true
        isResumingSession = false
        sessionError = nil
        selectedSessionID = nil
        needsSessionRestore = false
        needsRpcTransportResume = false

        await closeRpc()
        activeCacheSessionId = nil
        lastCachedMessageRevision = 0
        shouldRefreshAfterNewSession = true
        rpcSnapshot = PiRpcSnapshot(phase: .connecting)

        do {
            let link = try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: bootstrap.instanceId,
                generation: bootstrap.generation,
                access: bootstrap.access
            )
            let device = try await identityStore.publicIdentity()
            let client = try PiRpcClient(
                capabilityString: link.collabUrl,
                machineId: machine.id,
                deviceId: device.id
            ) { frame in
                try await relayClient.sendRpcFrame(frame)
            }

            rpcClient = client
            rpcEventsTask = Task { [weak self] in
                for await event in client.events {
                    await self?.handleRpcEvent(event)
                }
            }

            try await client.startFreshSession()
        } catch let error as PiRpcClient.ClientError {
            sessionError = error.localizedDescription

            if case .deliveredResponseUnavailable("new_session") = error {
                // Host accepted the command; destroying this RPC client could
                // discard the newly-created Pi session. Keep it alive and let
                // the resume reconciliation establish the authoritative
                // sessionId/state.
                shouldRefreshAfterNewSession = false
            } else {
                rpcSnapshot = nil
                rpcClient = nil
                shouldRefreshAfterNewSession = false
            }
        } catch {
            sessionError = error.localizedDescription
            rpcSnapshot = nil
            rpcClient = nil
            shouldRefreshAfterNewSession = false
        }

        isCreatingSession = false
    }

    func selectModel(_ model: PiModelOption) async {
        guard let rpcClient else { return }
        do {
            try await rpcClient.selectModel(model)
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func sendPrompt() async {
        let text = composerText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rpcClient else { return }

        do {
            try await rpcClient.sendPrompt(text)
            composerText = ""
        } catch let error as PiRpcClient.ClientError {
            if case .deliveredResponseUnavailable(_) = error {
                // Host sequence state proves this prompt was accepted for
                // delivery. Do not leave the original text in the composer,
                // which would invite an accidental duplicate retry.
                composerText = ""
            }
            sessionError = error.localizedDescription
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func abort() async {
        guard let rpcClient else { return }
        do {
            try await rpcClient.abort()
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func answerInteractiveRequest(
        id: String,
        method: String,
        value: String?,
        confirmed: Bool? = nil
    ) async {
        guard let rpcClient else { return }
        do {
            try await rpcClient.answerInteractiveRequest(
                id: id,
                method: method,
                value: value,
                confirmed: confirmed
            )
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func forgetHost() async {
        let machineId = profile?.machine.id

        await disconnectRelayAndRpc()

        do {
            if let machineId {
                try await grantStore.remove(machineId: machineId)
                try? await conversationCache.remove(machineId: machineId)
            }
            try await profileStore.clear()

            profile = nil
            selectedSessionID = nil
            pairingPayload = ""
            pairingError = nil
            sessionError = nil
            needsSessionRestore = false
            needsRpcTransportResume = false
            isResumingSession = false
            connectionState = .unpaired
        } catch {
            sessionError = error.localizedDescription
            connectionState = .disconnected
        }
    }

    func suspend() async {
        backgroundedAt = Date()
    }

    func resume() async {
        guard let profile else {
            backgroundedAt = nil
            connectionState = .unpaired
            return
        }

        // SwiftUI can deliver an initial .active scenePhase transition while
        // start() is still authenticating the first Relay connection. Treat
        // that as the same connection attempt instead of cancelling it and
        // starting a competing resume path.
        if relayConnectInFlight {
            backgroundedAt = nil
            return
        }

        let elapsed = backgroundedAt.map {
            Date().timeIntervalSince($0)
        }
        backgroundedAt = nil

        if let relayClient {
            let connected = await relayClient.isConnected()
            if connected,
               elapsed == nil
                || elapsed! <= backgroundGraceInterval {
                return
            }

            if rpcClient != nil, selectedSessionID != nil {
                needsRpcTransportResume = true
                needsSessionRestore = false
                isResumingSession = true
            } else {
                needsSessionRestore = selectedSessionID != nil
            }
            await disconnectRelayPreservingRpc()
        }

        do {
            try await connectRelay(profile: profile)
        } catch {
            connectionState = .disconnected
            sessionError = error.localizedDescription
        }
    }

    private func connectRelay(
        profile: PairedHostProfile
    ) async throws {
        relayConnectInFlight = true
        defer {
            relayConnectInFlight = false
        }

        let url = try await resolveRelayURL(
            relayURL: profile.relayURL,
            transport: profile.transport
        )

        connectionState = .connecting
        let client = makeRelayClient(url: url)
        relayClient = client

        do {
            try await client.connect()
        } catch {
            if relayClient === client {
                relayClient = nil
            }
            throw error
        }
    }

    private func resolveRelayURL(
        relayURL: String,
        transport: PairingTransport?
    ) async throws -> URL {
        if let transport, transport.kind == .tailcat {
            return try await tailcatTransport.endpoint(for: transport)
        }

        guard let url = URL(string: relayURL) else {
            throw StoreError.invalidRelayURL
        }
        return url
    }

    private func makeRelayClient(url: URL) -> RelayClient {
        RelayClient(
            configuration: .init(url: url),
            identityStore: identityStore,
            grantStore: grantStore
        ) { [weak self] event in
            await self?.handleRelayEvent(event)
        }
    }

    private func handleRelayEvent(_ event: RelayClient.Event) async {
        switch event {
        case let .machinesSnapshot(values):
            machines = values

            guard let profile else {
                activeMachine = nil
                return
            }

            let machine = values.first { value in
                value.id == profile.machine.id
                    && value.signingPublicKey
                        == profile.machine.signingPublicKey
                    && value.keyAgreementPublicKey
                        == profile.machine.keyAgreementPublicKey
            }

            activeMachine = machine

            guard let machine else {
                connectionState = .disconnected
                sessions = []
                return
            }

            connectionState = .connected(hostName: machine.name)

            // Do not await refreshSessions() from inside the RelayClient event
            // callback. The RelayClient receive loop is waiting for this
            // callback to return; awaiting a control response here would block
            // the same receive loop that must read that response.
            Task { [weak self] in
                await self?.refreshSessions()
            }

        case let .machinePresence(machineId, online):
            guard machineId == profile?.machine.id else { return }
            if !online {
                connectionState = .disconnected
                sessions = []
                activeMachine = nil
            }

        case let .rpcFrame(frame):
            guard let rpcClient else { return }
            do {
                try await rpcClient.receive(frame)
            } catch let error as PiRpcClient.ClientError {
                switch error {
                case .sequenceGap(_, _):
                    if !needsRpcTransportResume {
                        needsRpcTransportResume = true
                        needsSessionRestore = false
                        Task { [weak self] in
                            await self?.refreshSessions()
                        }
                    }
                default:
                    sessionError = error.localizedDescription
                }
            } catch {
                sessionError = error.localizedDescription
            }

        case let .transportClosed(reason):
            relayClient = nil
            if rpcClient != nil, selectedSessionID != nil {
                needsRpcTransportResume = true
                needsSessionRestore = false
                isResumingSession = true
            } else {
                needsSessionRestore = selectedSessionID != nil
            }

            if backgroundedAt == nil {
                connectionState = .disconnected
                sessionError = reason
            }
        }
    }

    private func resumeSessionTransport(
        _ session: RemoteSession
    ) async {
        guard !isOpeningSession, !resumeInFlight else { return }
        guard let machine = activeMachine,
              let relayClient,
              let rpcClient
        else {
            needsRpcTransportResume = false
            needsSessionRestore = false
            await openSession(session)
            return
        }

        resumeInFlight = true
        isResumingSession = true
        var shouldReopen = false

        do {
            let resumeFromHostSeq = await rpcClient.hostSequenceCursor()
            let link = try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: session.instanceId,
                generation: session.generation,
                access: session.access,
                resumeFromHostSeq: resumeFromHostSeq
            )
            let resumed = try await rpcClient.resumeTransport(
                capabilityString: link.collabUrl
            ) { frame in
                try await relayClient.sendRpcFrame(frame)
            }

            if resumed {
                needsRpcTransportResume = false
                needsSessionRestore = false
                isResumingSession = false
                sessionError = nil
            } else {
                shouldReopen = true
            }
        } catch {
            // A second transport failure during recovery must not destroy the
            // live PiRpcClient: it owns the reliable-command journal. Keep the
            // session in resume mode and let the next Relay connection retry.
            sessionError = error.localizedDescription
            needsRpcTransportResume = true
            needsSessionRestore = false
        }

        resumeInFlight = false

        if shouldReopen {
            needsRpcTransportResume = false
            needsSessionRestore = false
            isResumingSession = false
            await openSession(session)
        }
    }

    private func handleRpcEvent(
        _ event: PiRpcClientEvent
    ) async {
        switch event {
        case let .snapshot(snapshot):
            rpcSnapshot = snapshot

            if let sessionId = snapshot.state?
                .objectValue?["sessionId"]?
                .stringValue {
                activeCacheSessionId = sessionId
                if selectedSessionID == nil,
                   !shouldRefreshAfterNewSession {
                    selectedSessionID = sessionId
                }
            }

            guard snapshot.messageRevision > lastCachedMessageRevision,
                  let machine = activeMachine,
                  let sessionId = activeCacheSessionId
            else {
                return
            }

            lastCachedMessageRevision = snapshot.messageRevision
            try? await conversationCache.save(
                machineId: machine.id,
                sessionId: sessionId,
                messages: snapshot.messages
            )

            if shouldRefreshAfterNewSession,
               snapshot.messages.contains(where: { message in
                   message.objectValue?["role"]?.stringValue
                       == "assistant"
               }) {
                shouldRefreshAfterNewSession = false
                selectedSessionID = sessionId
                Task { [weak self] in
                    await self?.refreshSessions()
                }
            }

        case let .disconnected(reason):
            sessionError = reason
        }
    }

    private func closeRpc() async {
        rpcEventsTask?.cancel()
        rpcEventsTask = nil

        if let rpcClient {
            await rpcClient.close()
        }
        self.rpcClient = nil
        rpcSnapshot = nil
        activeCacheSessionId = nil
        lastCachedMessageRevision = 0
        shouldRefreshAfterNewSession = false
        needsRpcTransportResume = false
        isResumingSession = false
        resumeInFlight = false
    }

    private func disconnectRelayPreservingRpc() async {
        if let relayClient {
            await relayClient.disconnect()
        }
        self.relayClient = nil
        // Keep the last verified machine/session list and in-memory transcript.
        // They are presentation state only; the fresh Relay snapshot and Pi
        // reconciliation remain authoritative after reconnect.
    }

    private func disconnectRelayAndRpc() async {
        await closeRpc()

        if let relayClient {
            await relayClient.disconnect()
        }
        self.relayClient = nil
        await tailcatTransport.stop()
        activeMachine = nil
        machines = []
        sessions = []
    }

    private static func parseISO8601(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [
            .withInternetDateTime,
            .withFractionalSeconds
        ]
        if let date = formatter.date(from: value) {
            return date
        }

        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
