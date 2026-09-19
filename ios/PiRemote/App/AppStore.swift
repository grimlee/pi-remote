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
    var isCreatingSession = false

    private let identityStore = DeviceIdentityStore()
    private let grantStore = MachineGrantStore()
    private let profileStore = PairedHostProfileStore()
    private let conversationCache = ConversationCacheStore()

    private var profile: PairedHostProfile?
    private var relayClient: RelayClient?
    private var rpcClient: PiRpcClient?
    private var rpcEventsTask: Task<Void, Never>?
    private var started = false
    private var needsSessionRestore = false
    private var needsRpcTransportResume = false
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
            guard let relayURL = URL(string: bootstrap.relayUrl) else {
                throw StoreError.invalidRelayURL
            }

            await disconnectRelayAndRpc()

            let client = makeRelayClient(url: relayURL)
            relayClient = client
            connectionState = .connecting
            try await client.connect()

            let acceptance = try await client.pair(using: bootstrap)
            let pairedProfile = PairedHostProfile(
                relayURL: bootstrap.relayUrl,
                machine: acceptance.machine
            )
            try await profileStore.save(pairedProfile)
            profile = pairedProfile
            pairingPayload = ""
            connectionState = .connected(
                hostName: acceptance.machine.name
            )
        } catch {
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
            let link = try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: session.instanceId,
                generation: session.generation,
                access: session.access
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

    func createNewSession(from bootstrap: RemoteSession) async {
        guard !isOpeningSession, !isCreatingSession else { return }
        guard let machine = activeMachine,
              let relayClient
        else {
            sessionError = StoreError.noTrustedMachine.localizedDescription
            return
        }

        isCreatingSession = true
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
        guard let url = URL(string: profile.relayURL) else {
            throw StoreError.invalidRelayURL
        }

        connectionState = .connecting
        let client = makeRelayClient(url: url)
        relayClient = client

        do {
            try await client.connect()
        } catch {
            relayClient = nil
            throw error
        }
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
            } catch {
                sessionError = error.localizedDescription
            }

        case let .transportClosed(reason):
            relayClient = nil
            if rpcClient != nil, selectedSessionID != nil {
                needsRpcTransportResume = true
                needsSessionRestore = false
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
        guard !isOpeningSession else { return }
        guard let machine = activeMachine,
              let relayClient,
              let rpcClient
        else {
            needsRpcTransportResume = false
            needsSessionRestore = false
            await openSession(session)
            return
        }

        isOpeningSession = true
        var shouldReopen = false

        do {
            let link = try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: session.instanceId,
                generation: session.generation,
                access: session.access
            )
            let resumed = try await rpcClient.resumeTransport(
                capabilityString: link.collabUrl
            ) { frame in
                try await relayClient.sendRpcFrame(frame)
            }

            if resumed {
                needsRpcTransportResume = false
                needsSessionRestore = false
                sessionError = nil
            } else {
                shouldReopen = true
            }
        } catch {
            sessionError = error.localizedDescription
            shouldReopen = true
        }

        isOpeningSession = false

        if shouldReopen {
            needsRpcTransportResume = false
            needsSessionRestore = false
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
    }

    private func disconnectRelayPreservingRpc() async {
        if let relayClient {
            await relayClient.disconnect()
        }
        self.relayClient = nil
        activeMachine = nil
        machines = []
        sessions = []
    }

    private func disconnectRelayAndRpc() async {
        await closeRpc()

        if let relayClient {
            await relayClient.disconnect()
        }
        self.relayClient = nil
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
