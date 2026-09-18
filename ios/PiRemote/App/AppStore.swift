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

    private let identityStore = DeviceIdentityStore()
    private let grantStore = MachineGrantStore()
    private let profileStore = PairedHostProfileStore()

    private var profile: PairedHostProfile?
    private var relayClient: RelayClient?
    private var rpcClient: PiRpcClient?
    private var rpcEventsTask: Task<Void, Never>?
    private var started = false
    private var needsSessionRestore = false
    private var activeMachine: RemoteMachine?

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

        do {
            let values = try await relayClient.listSessions(
                machineId: machine.id
            )
            sessions = values
                .sorted { $0.startedAt > $1.startedAt }

            if needsSessionRestore,
               let selectedSessionID,
               let session = sessions.first(
                where: { $0.instanceId == selectedSessionID }
               ) {
                needsSessionRestore = false
                await openSession(session)
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

        await closeRpc()

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
                deviceId: device.id
            ) { frame in
                try await relayClient.sendRpcFrame(frame)
            }

            rpcClient = client
            rpcSnapshot = PiRpcSnapshot(phase: .connecting)

            rpcEventsTask = Task { [weak self] in
                for await event in client.events {
                    await self?.handleRpcEvent(event)
                }
            }

            try await client.start()
        } catch {
            sessionError = error.localizedDescription
            rpcSnapshot = nil
            rpcClient = nil
        }

        isOpeningSession = false
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
            try await rpcClient.sendAbort()
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
            }
            try await profileStore.clear()

            profile = nil
            selectedSessionID = nil
            pairingPayload = ""
            pairingError = nil
            sessionError = nil
            needsSessionRestore = false
            connectionState = .unpaired
        } catch {
            sessionError = error.localizedDescription
            connectionState = .disconnected
        }
    }

    func suspend() async {
        needsSessionRestore = selectedSessionID != nil
        await disconnectRelayAndRpc()
        if profile != nil {
            connectionState = .disconnected
        }
    }

    func resume() async {
        guard let profile else {
            connectionState = .unpaired
            return
        }
        guard relayClient == nil else { return }

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
            await refreshSessions()

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
        }
    }

    private func handleRpcEvent(
        _ event: PiRpcClientEvent
    ) {
        switch event {
        case let .snapshot(snapshot):
            rpcSnapshot = snapshot

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
