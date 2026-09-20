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
    var pairingError: String?
    var sessionError: String?
    var isPairing = false
    var isOpeningSession = false
    var isResumingSession = false
    var isCreatingSession = false
    var isUsingRelayFallback = false

    var hasRelayFallback: Bool {
        profile?.fallbackRelayURL != nil
    }

    var canSetUpQuickConnect: Bool {
        guard let profile else { return false }
        return profile.transport?.kind != .tailcat
    }

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
    private var activeRpcSessionID: String?
    private var activeCacheSessionId: String?
    private var lastCachedMessageRevision = 0
    private var shouldRefreshAfterNewSession = false
    private var isDeferringConversationPresentation = false
    private var deferredRpcSnapshot: PiRpcSnapshot?
    private var sessionListReconciliationTask: Task<Void, Never>?
    private var sessionListReconciliationID: String?
    private var backgroundedAt: Date?
    private var diagnosticLastRpcSnapshotSignature: String?
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

            var fallbackRelayURL: String?
            if bootstrap.transport?.kind == .tailcat,
               let existing = profile,
               existing.machine.id == acceptance.machine.id {
                if existing.transport?.kind == .tailcat {
                    fallbackRelayURL = existing.fallbackRelayURL
                } else if let existingURL = URL(
                    string: existing.relayURL
                ), existingURL.scheme?.lowercased() == "wss" {
                    // Migrating an existing Relay/CF pairing to Tailcat should
                    // not discard the mature fallback endpoint.
                    fallbackRelayURL = existing.relayURL
                }
            }

            let pairedProfile = PairedHostProfile(
                relayURL: bootstrap.relayUrl,
                transport: bootstrap.transport,
                fallbackRelayURL: fallbackRelayURL,
                machine: acceptance.machine
            )
            try await profileStore.save(pairedProfile)
            profile = pairedProfile
            isUsingRelayFallback = false
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
                .sorted { $0.activityAt > $1.activityAt }
            sessionError = nil

            if let activeRpcSessionID,
               sessions.contains(where: {
                   $0.instanceId == activeRpcSessionID
               }) {
                shouldRefreshAfterNewSession = false
            }

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

    func refreshSessionsForList() async {
        await refreshSessions()

        guard let sessionId = activeRpcSessionID,
              !sessions.contains(where: {
                  $0.instanceId == sessionId
              })
        else {
            return
        }

        scheduleSessionListReconciliation(sessionId: sessionId)
    }

    func openSession(_ session: RemoteSession) async {
        guard !isOpeningSession else { return }

        let openStartedAtMs = diagnosticNowMs()
        let openStartedAt = ProcessInfo.processInfo.systemUptime
        reportDiagnosticTiming(
            stage: "open.begin",
            startedAtMs: openStartedAtMs,
            durationMs: 0,
            detail: "sid=\(diagnosticShortID(session.instanceId))"
        )

        // Navigation is presentation state, not Pi process ownership. If the
        // user leaves a conversation view and re-enters the same session, keep
        // the existing RPC channel alive instead of sending piremote.close and
        // spawning a replacement Pi process. This is especially important
        // while the agent is streaming a response.
        if activeRpcSessionID == session.instanceId,
           rpcClient != nil,
           let phase = rpcSnapshot?.phase {
            switch phase {
            case .connecting, .live:
                selectedSessionID = session.instanceId
                sessionError = nil
                reportDiagnosticTiming(
                    stage: "open.reuse",
                    startedAtMs: openStartedAtMs,
                    durationMs: diagnosticElapsedMs(
                        since: openStartedAt
                    ),
                    detail: "sid=\(diagnosticShortID(session.instanceId))"
                )
                return
            case .closed:
                break
            }
        }

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

        let closeStartedAtMs = diagnosticNowMs()
        let closeStartedAt = ProcessInfo.processInfo.systemUptime
        await closeRpc()
        reportDiagnosticTiming(
            stage: "open.closeRpc",
            startedAtMs: closeStartedAtMs,
            durationMs: diagnosticElapsedMs(since: closeStartedAt),
            detail: "sid=\(diagnosticShortID(session.instanceId))"
        )

        activeRpcSessionID = session.instanceId
        activeCacheSessionId = session.sessionId
        lastCachedMessageRevision = 0

        let cacheStartedAtMs = diagnosticNowMs()
        let cacheStartedAt = ProcessInfo.processInfo.systemUptime
        let cachedMessages = (
            try? await conversationCache.load(
                machineId: machine.id,
                sessionId: session.sessionId
            )
        ) ?? []
        reportDiagnosticTiming(
            stage: "open.cache",
            startedAtMs: cacheStartedAtMs,
            durationMs: diagnosticElapsedMs(since: cacheStartedAt),
            detail: "sid=\(diagnosticShortID(session.instanceId))|m=\(cachedMessages.count)"
        )

        let snapshotStartedAtMs = diagnosticNowMs()
        let snapshotStartedAt = ProcessInfo.processInfo.systemUptime
        rpcSnapshot = PiRpcSnapshot(
            phase: .connecting,
            messages: cachedMessages
        )
        reportDiagnosticTiming(
            stage: "open.snapshot",
            startedAtMs: snapshotStartedAtMs,
            durationMs: diagnosticElapsedMs(since: snapshotStartedAt),
            detail: "sid=\(diagnosticShortID(session.instanceId))|m=\(cachedMessages.count)"
        )

        do {
            let linkStartedAtMs = diagnosticNowMs()
            let linkStartedAt = ProcessInfo.processInfo.systemUptime
            let link = try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: session.instanceId,
                generation: session.generation,
                access: session.access
            )
            reportDiagnosticTiming(
                stage: "open.link",
                startedAtMs: linkStartedAtMs,
                durationMs: diagnosticElapsedMs(since: linkStartedAt),
                detail: "sid=\(diagnosticShortID(session.instanceId))"
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

            let startStartedAtMs = diagnosticNowMs()
            let startStartedAt = ProcessInfo.processInfo.systemUptime
            try await client.start()
            reportDiagnosticTiming(
                stage: "open.rpcStart",
                startedAtMs: startStartedAtMs,
                durationMs: diagnosticElapsedMs(since: startStartedAt),
                detail: "sid=\(diagnosticShortID(session.instanceId))"
            )
        } catch {
            reportDiagnosticTiming(
                stage: "open.error",
                startedAtMs: openStartedAtMs,
                durationMs: diagnosticElapsedMs(since: openStartedAt),
                detail: "sid=\(diagnosticShortID(session.instanceId))"
            )
            sessionError = error.localizedDescription
            rpcClient = nil
            activeRpcSessionID = nil

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
        reportDiagnosticTiming(
            stage: "open.total",
            startedAtMs: openStartedAtMs,
            durationMs: diagnosticElapsedMs(since: openStartedAt),
            detail: "sid=\(diagnosticShortID(session.instanceId))|m=\(cachedMessages.count)"
        )
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
        activeRpcSessionID = nil
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
                // sessionId/state. Keep the pending list refresh armed so the
                // session becomes visible as soon as that state arrives.
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

    func setThinkingLevel(_ level: String) async {
        guard let rpcClient else { return }
        do {
            try await rpcClient.setThinkingLevel(level)
            sessionError = nil
        } catch {
            sessionError = error.localizedDescription
        }
    }

    func compactContext(_ instructions: String?) async -> JSONValue? {
        guard let rpcClient else { return nil }
        do {
            let result = try await rpcClient.compact(instructions)
            sessionError = nil
            return result
        } catch {
            sessionError = error.localizedDescription
            return nil
        }
    }

    func setSessionName(_ name: String) async -> Bool {
        guard let rpcClient else { return false }
        do {
            try await rpcClient.setSessionName(name)
            sessionError = nil
            await refreshSessions()
            return true
        } catch {
            sessionError = error.localizedDescription
            return false
        }
    }

    func fetchSessionStats() async -> JSONValue? {
        guard let rpcClient else { return nil }
        do {
            let value = try await rpcClient.sessionStats()
            sessionError = nil
            return value
        } catch {
            sessionError = error.localizedDescription
            return nil
        }
    }

    func fetchLastAssistantText() async -> String? {
        guard let rpcClient else { return nil }
        do {
            let value = try await rpcClient.lastAssistantText()
            sessionError = nil
            return value
        } catch {
            sessionError = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    func sendPrompt(_ text: String) async -> Bool {
        let trimmed = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let rpcClient else { return false }

        reportDiagnosticTiming(
            stage: "prompt.submit",
            startedAtMs: diagnosticNowMs(),
            durationMs: 0,
            detail: "chars=\(trimmed.count)|sid=\(diagnosticShortID(activeRpcSessionID ?? ""))"
        )

        do {
            try await rpcClient.sendPrompt(trimmed)
            sessionError = nil
            scheduleActiveSessionListReconciliation()
            return true
        } catch let error as PiRpcClient.ClientError {
            sessionError = error.localizedDescription

            if case .deliveredResponseUnavailable(_) = error {
                // Host sequence state proves this prompt was accepted for
                // delivery. Treat it as accepted so the UI never restores a
                // draft that could be accidentally sent twice.
                scheduleActiveSessionListReconciliation()
                return true
            }
            return false
        } catch {
            sessionError = error.localizedDescription
            return false
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

    func beginConversationInteraction() {
        guard !isDeferringConversationPresentation else {
            return
        }
        isDeferringConversationPresentation = true
        deferredRpcSnapshot = nil
    }

    func endConversationInteraction() {
        guard isDeferringConversationPresentation else {
            return
        }

        isDeferringConversationPresentation = false
        if let deferredRpcSnapshot {
            self.deferredRpcSnapshot = nil
            rpcSnapshot = deferredRpcSnapshot
        }
    }

    func reportDiagnosticTiming(
        stage: String,
        startedAtMs: Int64,
        durationMs: Int,
        detail: String = ""
    ) {
        guard let machine = activeMachine,
              let relayClient
        else {
            return
        }

        let safeStage = diagnosticSanitize(stage, limit: 48)
        let safeDetail = diagnosticSanitize(detail, limit: 128)
        var marker = "diag|stage=\(safeStage)|dur=\(max(0, durationMs))"
            + "|at=\(startedAtMs)"
        if !safeDetail.isEmpty {
            marker += "|\(safeDetail)"
        }

        let report = ConversationPerformanceReport(
            sessionId: String(marker.prefix(240)),
            windowStartedAtMs: max(0, startedAtMs),
            windowDurationMs: min(
                60_000,
                max(500, durationMs)
            ),
            displayFrames: 0,
            slowFrames25Ms: 0,
            slowFrames50Ms: 0,
            dragFrames: 0,
            dragSlowFrames25Ms: 0,
            maxFrameGapMs: 0,
            snapshotCount: 0,
            liveCharacters: 0,
            isStreaming: false
        )

        Task {
            try? await relayClient.sendDiagnostics(
                machineId: machine.id,
                report: report
            )
        }
    }

    private func diagnosticRpcSnapshotSignature(
        _ snapshot: PiRpcSnapshot
    ) -> String {
        let streaming = snapshot.state?
            .objectValue?["isStreaming"]?
            .boolValue == true
        let liveRole = snapshot.liveMessage?
            .objectValue?["role"]?
            .stringValue ?? "none"
        let liveTypes = diagnosticLiveBlockTypes(
            snapshot.liveMessage
        )

        let tpsVisible = snapshot.decodeTokensPerSecond != nil
        let statsVisible = snapshot.sessionStats != nil

        return [
            "event=\(snapshot.diagnosticEvent ?? "none")",
            "stream=\(streaming ? 1 : 0)",
            "live=\(snapshot.liveMessage == nil ? 0 : 1)",
            "role=\(liveRole)",
            "types=\(liveTypes)",
            "rev=\(snapshot.messageRevision)",
            "m=\(snapshot.messages.count)",
            "pr=\(snapshot.presentationRevision)",
            "chars=\(snapshot.liveCharacterCount)",
            "stats=\(statsVisible ? 1 : 0)",
            "tps=\(tpsVisible ? 1 : 0)"
        ].joined(separator: "|")
    }

    private func diagnosticLiveBlockTypes(
        _ value: JSONValue?
    ) -> String {
        guard let content = value?
            .objectValue?["content"]?
            .arrayValue
        else {
            return "none"
        }

        let types = content.compactMap {
            $0.objectValue?["type"]?.stringValue
        }
        guard !types.isEmpty else {
            return "empty"
        }
        return types.joined(separator: ".")
    }

    private func diagnosticNowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }

    private func diagnosticElapsedMs(
        since startedAt: TimeInterval
    ) -> Int {
        max(
            0,
            Int(
                (
                    (
                        ProcessInfo.processInfo.systemUptime
                            - startedAt
                    ) * 1_000
                ).rounded()
            )
        )
    }

    private func diagnosticShortID(_ value: String) -> String {
        String(value.prefix(12))
    }

    private func diagnosticSanitize(
        _ value: String,
        limit: Int
    ) -> String {
        let safe = value.map { character -> Character in
            if character.isLetter
                || character.isNumber
                || "-_.=|".contains(character) {
                return character
            }
            return "_"
        }
        return String(safe.prefix(limit))
    }

    func reportPerformance(
        _ report: ConversationPerformanceReport
    ) async {
        guard let machine = activeMachine,
              let relayClient
        else {
            return
        }

        let enriched = ConversationPerformanceReport(
            sessionId: selectedSessionID ?? "",
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

        // Diagnostics are intentionally best-effort. They must never surface
        // an error or disturb the conversation UX if telemetry delivery fails.
        try? await relayClient.sendDiagnostics(
            machineId: machine.id,
            report: enriched
        )

        await reportTailcatDiagnostics(
            stage: "tailcat.perf",
            startedAtMs: report.windowStartedAtMs,
            durationMs: report.windowDurationMs
        )
    }

    private func reportTailcatDiagnostics(
        stage: String,
        startedAtMs: Int64,
        durationMs: Int
    ) async {
        guard !isUsingRelayFallback,
              profile?.transport?.kind == .tailcat,
              let machine = activeMachine,
              let relayClient
        else {
            return
        }

        do {
            // Never probe here: a DiscoPing would add traffic and could itself
            // perturb the scroll-performance experiment. The native counters
            // and recent event ring are read-only snapshots.
            let value = try await tailcatTransport.diagnostics(
                probe: false
            )
            let latest = value.events?.last
            let latestEvent = latest.map { event in
                let detail = event.detail.map {
                    diagnosticSanitize($0, limit: 36)
                } ?? ""
                return detail.isEmpty
                    ? diagnosticSanitize(event.event, limit: 24)
                    : diagnosticSanitize(
                        event.event,
                        limit: 18
                    ) + ":" + detail
            } ?? "none"

            let detail = [
                "acc=\(value.acceptedConnections)",
                "active=\(value.activeConnections)",
                "ok=\(value.dialSuccesses)",
                "fail=\(value.dialFailures)",
                "tx=\(value.bytesToHost)",
                "rx=\(value.bytesToPhone)",
                "err=\(value.lastError == nil ? 0 : 1)",
                "ev=\(latestEvent)"
            ].joined(separator: "|")

            let marker = "diag|stage=\(diagnosticSanitize(stage, limit: 48))"
                + "|dur=\(max(0, durationMs))"
                + "|at=\(startedAtMs)"
                + "|\(diagnosticSanitize(detail, limit: 160))"

            let report = ConversationPerformanceReport(
                sessionId: String(marker.prefix(300)),
                windowStartedAtMs: max(0, startedAtMs),
                windowDurationMs: min(
                    60_000,
                    max(500, durationMs)
                ),
                displayFrames: 0,
                slowFrames25Ms: 0,
                slowFrames50Ms: 0,
                dragFrames: 0,
                dragSlowFrames25Ms: 0,
                maxFrameGapMs: 0,
                snapshotCount: 0,
                liveCharacters: 0,
                isStreaming: false
            )

            try? await relayClient.sendDiagnostics(
                machineId: machine.id,
                report: report
            )
        } catch {
            let detail = "unavailable="
                + diagnosticSanitize(
                    error.localizedDescription,
                    limit: 96
                )
            let marker = "diag|stage=\(diagnosticSanitize(stage, limit: 48))"
                + "|dur=\(max(0, durationMs))"
                + "|at=\(startedAtMs)|\(detail)"

            let report = ConversationPerformanceReport(
                sessionId: String(marker.prefix(300)),
                windowStartedAtMs: max(0, startedAtMs),
                windowDurationMs: min(
                    60_000,
                    max(500, durationMs)
                ),
                displayFrames: 0,
                slowFrames25Ms: 0,
                slowFrames50Ms: 0,
                dragFrames: 0,
                dragSlowFrames25Ms: 0,
                maxFrameGapMs: 0,
                snapshotCount: 0,
                liveCharacters: 0,
                isStreaming: false
            )
            try? await relayClient.sendDiagnostics(
                machineId: machine.id,
                report: report
            )
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
            isUsingRelayFallback = false
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
        let now = Date()
        backgroundedAt = now
        reportDiagnosticTiming(
            stage: "lifecycle.background",
            startedAtMs: diagnosticNowMs(),
            durationMs: 0,
            detail: lifecycleDiagnosticDetail()
        )
    }

    func resume() async {
        guard let profile else {
            backgroundedAt = nil
            connectionState = .unpaired
            return
        }

        // SwiftUI can deliver an initial .active scenePhase transition while
        // start() is still authenticating the first Relay WebSocket. Treat
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

        reportDiagnosticTiming(
            stage: "lifecycle.resume.begin",
            startedAtMs: diagnosticNowMs(),
            durationMs: 0,
            detail: lifecycleDiagnosticDetail(
                elapsed: elapsed
            )
        )

        let wasDisconnected: Bool
        if case .disconnected = connectionState {
            wasDisconnected = true
        } else {
            wasDisconnected = false
        }
        let exceededBackgroundGrace =
            elapsed.map { $0 > backgroundGraceInterval } ?? false

        if let relayClient {
            let connected = await relayClient.isConnected()

            // A live Relay WebSocket is not enough to declare recovery
            // complete. The Host can be unavailable while the client socket
            // itself still reports .running. In that state the explicit
            // Reconnect button calls resume(), so returning here would turn
            // Reconnect into a no-op.
            if connected,
               !wasDisconnected,
               !exceededBackgroundGrace {
                reportDiagnosticTiming(
                    stage: "lifecycle.resume.reuse",
                    startedAtMs: diagnosticNowMs(),
                    durationMs: 0,
                    detail: lifecycleDiagnosticDetail(
                        elapsed: elapsed
                    )
                )
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
        } else if rpcClient != nil, selectedSessionID != nil {
            // transportClosed can clear relayClient while the app is
            // suspended. Preserve the live Pi RPC journal so the fresh Relay
            // connection can resume the same channel after foregrounding.
            needsRpcTransportResume = true
            needsSessionRestore = false
            isResumingSession = true
        } else {
            needsSessionRestore = selectedSessionID != nil
        }

        if !isUsingRelayFallback,
           profile.transport?.kind == .tailcat,
           wasDisconnected || exceededBackgroundGrace {
            // The native Quick Connect bridge lives inside the iOS process.
            // After a long suspension its cached handle/local port can look
            // valid even though the underlying path is stale. Force a fresh
            // bridge for long-background recovery and explicit reconnects.
            await tailcatTransport.stop()
        }

        do {
            try await connectRelay(profile: profile)
            reportDiagnosticTiming(
                stage: "lifecycle.resume.reconnect",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: lifecycleDiagnosticDetail(
                    elapsed: elapsed
                )
            )
        } catch {
            connectionState = .disconnected
            sessionError = error.localizedDescription
        }
    }

    private func lifecycleDiagnosticDetail(
        elapsed: TimeInterval? = nil
    ) -> String {
        let streaming = rpcSnapshot?.state?
            .objectValue?["isStreaming"]?
            .boolValue == true
        let phase = rpcSnapshot?.phase.rawValue ?? "none"
        let elapsedMs = elapsed.map {
            max(0, Int(($0 * 1_000).rounded()))
        } ?? 0

        return "elapsed=\(elapsedMs)"
            + "|phase=\(phase)"
            + "|stream=\(streaming ? 1 : 0)"
            + "|rpc=\(rpcClient == nil ? 0 : 1)"
            + "|relay=\(relayClient == nil ? 0 : 1)"
            + "|resume=\(needsRpcTransportResume ? 1 : 0)"
    }

    private func connectRelay(
        profile: PairedHostProfile
    ) async throws {
        relayConnectInFlight = true
        defer {
            relayConnectInFlight = false
        }

        connectionState = .connecting

        let url: URL
        if isUsingRelayFallback,
           let fallback = profile.fallbackRelayURL,
           let fallbackURL = URL(string: fallback),
           fallbackURL.scheme?.lowercased() == "wss" {
            url = fallbackURL
        } else {
            url = try await resolveRelayURL(
                relayURL: profile.relayURL,
                transport: profile.transport
            )
        }

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

    func useBackupConnection() async {
        guard let profile,
              profile.fallbackRelayURL != nil,
              !relayConnectInFlight
        else {
            return
        }

        if let relayClient {
            if rpcClient != nil, selectedSessionID != nil {
                needsRpcTransportResume = true
                needsSessionRestore = false
                isResumingSession = true
            } else {
                needsSessionRestore = selectedSessionID != nil
            }
            await disconnectRelayPreservingRpc()
        }

        await tailcatTransport.stop()
        isUsingRelayFallback = true

        do {
            try await connectRelay(profile: profile)
            sessionError = nil
        } catch {
            connectionState = .disconnected
            sessionError = error.localizedDescription
        }
    }

    func usePreferredConnection() async {
        guard let profile, !relayConnectInFlight else { return }

        if let relayClient {
            if rpcClient != nil, selectedSessionID != nil {
                needsRpcTransportResume = true
                needsSessionRestore = false
                isResumingSession = true
            } else {
                needsSessionRestore = selectedSessionID != nil
            }
            await disconnectRelayPreservingRpc()
        }

        isUsingRelayFallback = false

        do {
            try await connectRelay(profile: profile)
            sessionError = nil
        } catch {
            connectionState = .disconnected
            sessionError = error.localizedDescription
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
                reportDiagnosticTiming(
                    stage: "rpc.receive.error",
                    startedAtMs: diagnosticNowMs(),
                    durationMs: 0,
                    detail: "ch=\(diagnosticShortID(frame.channelId))|seq=\(frame.seq)|e=\(error.localizedDescription)"
                )
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
                reportDiagnosticTiming(
                    stage: "rpc.receive.error",
                    startedAtMs: diagnosticNowMs(),
                    durationMs: 0,
                    detail: "ch=\(diagnosticShortID(frame.channelId))|seq=\(frame.seq)|e=\(error.localizedDescription)"
                )
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

        reportDiagnosticTiming(
            stage: "resume.transport.begin",
            startedAtMs: diagnosticNowMs(),
            durationMs: 0,
            detail: "sid=\(diagnosticShortID(session.instanceId))"
        )

        do {
            let resumeFromHostSeq = await rpcClient.hostSequenceCursor()
            reportDiagnosticTiming(
                stage: "resume.transport.cursor",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: "seq=\(resumeFromHostSeq)"
            )

            let link = try await relayClient.requestSessionLink(
                machine: machine,
                instanceId: session.instanceId,
                generation: session.generation,
                access: session.access,
                resumeFromHostSeq: resumeFromHostSeq
            )
            reportDiagnosticTiming(
                stage: "resume.transport.link",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: "seq=\(resumeFromHostSeq)"
            )

            reportDiagnosticTiming(
                stage: "resume.transport.rpc.begin",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: "seq=\(resumeFromHostSeq)"
            )
            let resumed = try await rpcClient.resumeTransport(
                capabilityString: link.collabUrl
            ) { frame in
                try await relayClient.sendRpcFrame(frame)
            }
            reportDiagnosticTiming(
                stage: "resume.transport.rpc.end",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: "ok=\(resumed ? 1 : 0)"
            )

            if resumed {
                needsRpcTransportResume = false
                needsSessionRestore = false
                isResumingSession = false
                sessionError = nil
            } else {
                shouldReopen = true
            }
        } catch {
            reportDiagnosticTiming(
                stage: "resume.transport.error",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: "e=\(error.localizedDescription)"
            )

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
            let isStreamingPresentation =
                snapshot.liveMessage != nil
                || snapshot.state?
                    .objectValue?["isStreaming"]?
                    .boolValue == true

            let diagnosticSignature = diagnosticRpcSnapshotSignature(
                snapshot
            )
            if diagnosticSignature != diagnosticLastRpcSnapshotSignature {
                diagnosticLastRpcSnapshotSignature = diagnosticSignature
                reportDiagnosticTiming(
                    stage: "rpc.snapshot",
                    startedAtMs: diagnosticNowMs(),
                    durationMs: 0,
                    detail: diagnosticSignature
                        + "|def=\(isDeferringConversationPresentation ? 1 : 0)"
                )
            }

            if isDeferringConversationPresentation,
               isStreamingPresentation {
                // Keep transport/RPC/cache state fully live while the user's
                // finger owns the scroll gesture. Only defer the expensive
                // SwiftUI presentation update, latest-wins. Releasing the
                // gesture publishes one current snapshot and normal cadence
                // resumes unchanged.
                deferredRpcSnapshot = snapshot
            } else {
                deferredRpcSnapshot = nil
                rpcSnapshot = snapshot
            }

            if let sessionId = snapshot.state?
                .objectValue?["sessionId"]?
                .stringValue {
                activeRpcSessionID = sessionId
                activeCacheSessionId = sessionId

                if shouldRefreshAfterNewSession
                    || selectedSessionID == nil {
                    selectedSessionID = sessionId
                }

                let hasPersistableActivity =
                    !snapshot.messages.isEmpty
                    || snapshot.liveMessage != nil
                    || snapshot.state?
                        .objectValue?["isStreaming"]?
                        .boolValue == true

                if hasPersistableActivity,
                   !sessions.contains(where: {
                       $0.instanceId == sessionId
                   }) {
                    // A fresh Pi session can expose its sessionId before its
                    // JSONL file exists. Reconcile once prompt/stream activity
                    // can actually be persisted. This also repairs sessions
                    // resumed after an app restart, when the in-memory fresh
                    // session flag no longer exists.
                    scheduleSessionListReconciliation(
                        sessionId: sessionId
                    )
                }
            }

            guard snapshot.messageRevision > lastCachedMessageRevision,
                  let machine = activeMachine,
                  let sessionId = activeCacheSessionId
            else {
                return
            }

            reportDiagnosticTiming(
                stage: "rpc.messages",
                startedAtMs: diagnosticNowMs(),
                durationMs: 0,
                detail: "rev=\(snapshot.messageRevision)|m=\(snapshot.messages.count)"
            )

            lastCachedMessageRevision = snapshot.messageRevision
            try? await conversationCache.save(
                machineId: machine.id,
                sessionId: sessionId,
                messages: snapshot.messages
            )

        case let .disconnected(reason):
            sessionError = reason
        }
    }

    private func scheduleActiveSessionListReconciliation() {
        guard let sessionId = activeRpcSessionID,
              !sessions.contains(where: {
                  $0.instanceId == sessionId
              })
        else {
            return
        }

        scheduleSessionListReconciliation(sessionId: sessionId)
    }

    private func scheduleSessionListReconciliation(
        sessionId: String
    ) {
        if sessionListReconciliationID == sessionId,
           sessionListReconciliationTask != nil {
            return
        }

        sessionListReconciliationTask?.cancel()
        sessionListReconciliationID = sessionId
        sessionListReconciliationTask = Task { [weak self] in
            await self?.refreshSessionsUntilVisible(
                sessionId: sessionId
            )
        }
    }

    private func refreshSessionsUntilVisible(
        sessionId: String
    ) async {
        defer {
            if sessionListReconciliationID == sessionId {
                sessionListReconciliationID = nil
                sessionListReconciliationTask = nil
            }
        }

        for attempt in 0..<24 {
            guard !Task.isCancelled else { return }

            await refreshSessions()

            if sessions.contains(where: {
                $0.instanceId == sessionId
            }) {
                shouldRefreshAfterNewSession = false
                return
            }

            guard attempt < 23 else { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    private func closeRpc() async {
        sessionListReconciliationTask?.cancel()
        sessionListReconciliationTask = nil
        sessionListReconciliationID = nil
        rpcEventsTask?.cancel()
        rpcEventsTask = nil

        if let rpcClient {
            await rpcClient.close()
        }
        self.rpcClient = nil
        rpcSnapshot = nil
        activeRpcSessionID = nil
        activeCacheSessionId = nil
        lastCachedMessageRevision = 0
        shouldRefreshAfterNewSession = false
        isDeferringConversationPresentation = false
        deferredRpcSnapshot = nil
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
