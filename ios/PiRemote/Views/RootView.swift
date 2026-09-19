import PiRemoteCore
import SwiftUI
import UIKit

private enum SessionRoute: Hashable {
    case existing(RemoteSession)
    case fresh(RemoteSession)
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [SessionRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Pi Remote")
                .navigationDestination(for: SessionRoute.self) { route in
                    switch route {
                    case let .existing(session):
                        SessionDetailView(
                            session: session,
                            startFresh: false
                        )

                    case let .fresh(session):
                        SessionDetailView(
                            session: session,
                            startFresh: true
                        )
                    }
                }
                .toolbar {
                    if case .connected = store.connectionState,
                       !projectSessions.isEmpty {
                        ToolbarItem(placement: .topBarTrailing) {
                            Menu {
                                Section("New session in") {
                                    ForEach(projectSessions) { session in
                                        Button {
                                            path.append(.fresh(session))
                                        } label: {
                                            Label(
                                                projectName(session.cwd),
                                                systemImage: "folder"
                                            )
                                        }
                                    }
                                }
                            } label: {
                                Image(systemName: "square.and.pencil")
                            }
                            .accessibilityLabel("New Pi session")
                        }
                    }
                }
        }
        .task {
            await store.start()
        }
        .onChange(of: scenePhase) { _, phase in
            Task {
                switch phase {
                case .active:
                    await store.resume()
                case .background:
                    await store.suspend()
                case .inactive:
                    break
                @unknown default:
                    break
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.connectionState {
        case .unpaired:
            PairingView()

        case .connecting:
            VStack(spacing: 16) {
                ProgressView()
                Text("Connecting to Pi Remote Relay…")
                    .foregroundStyle(.secondary)
            }

        case let .connected(hostName):
            if store.sessions.isEmpty {
                ContentUnavailableView {
                    Label(
                        hostName,
                        systemImage: "desktopcomputer"
                    )
                } description: {
                    Text(
                        store.sessionError
                            ?? "Host returned 0 persisted Pi sessions."
                    )
                } actions: {
                    Button("Refresh Sessions") {
                        Task {
                            await store.refreshSessions()
                        }
                    }
                }
            } else {
                List {
                    Section {
                        ForEach(store.sessions) { session in
                            NavigationLink(
                                value: SessionRoute.existing(session)
                            ) {
                                SessionRow(session: session)
                            }
                        }
                    }

                    Section {
                        Button(
                            "Forget Host",
                            role: .destructive
                        ) {
                            Task {
                                await store.forgetHost()
                            }
                        }
                    }
                }
                .refreshable {
                    await store.refreshSessions()
                }
            }

        case .disconnected:
            ContentUnavailableView {
                Label(
                    "Host unavailable",
                    systemImage: "wifi.slash"
                )
            } description: {
                Text(
                    store.sessionError
                        ?? "Reconnect to the trusted host and refresh its authoritative state."
                )
            } actions: {
                Button("Reconnect") {
                    Task {
                        await store.resume()
                    }
                }
                .buttonStyle(.borderedProminent)

                Button(
                    "Forget Host",
                    role: .destructive
                ) {
                    Task {
                        await store.forgetHost()
                    }
                }
            }
        }
    }

    private var projectSessions: [RemoteSession] {
        var seen = Set<String>()
        return store.sessions.filter { session in
            seen.insert(session.cwd).inserted
        }
    }

    private func projectName(_ cwd: String) -> String {
        let name = URL(fileURLWithPath: cwd)
            .lastPathComponent
        return name.isEmpty ? cwd : name
    }
}

private struct PairingView: View {
    @Environment(AppStore.self) private var store
    @State private var showingScanner = false
    @State private var scannerError: String?

    var body: some View {
        @Bindable var store = store

        Form {
            Section {
                Text(
                    "Start Pi Remote on your computer, then scan the pairing QR code shown in its terminal."
                )
                .font(.callout)
                .foregroundStyle(.secondary)

                Button {
                    scannerError = nil
                    showingScanner = true
                } label: {
                    Label(
                        "Scan Pairing QR Code",
                        systemImage: "qrcode.viewfinder"
                    )
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isPairing)
            } header: {
                Text("Pair with your computer")
            }

            if let pairingError = store.pairingError {
                Section {
                    Text(pairingError)
                        .foregroundStyle(.red)
                }
            }

            if let scannerError {
                Section {
                    Text(scannerError)
                        .foregroundStyle(.red)
                }
            }

            Section("Manual pairing") {
                TextEditor(text: $store.pairingPayload)
                    .font(
                        .system(
                            .caption,
                            design: .monospaced
                        )
                    )
                    .frame(minHeight: 100)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Button("Paste from Clipboard") {
                    if let value = UIPasteboard.general.string {
                        store.pairingPayload = value
                    }
                }

                Button {
                    Task {
                        await store.pairFromPayload()
                    }
                } label: {
                    HStack {
                        if store.isPairing {
                            ProgressView()
                        }
                        Text(
                            store.isPairing
                                ? "Pairing…"
                                : "Pair using code"
                        )
                    }
                }
                .disabled(
                    store.isPairing
                        || store.pairingPayload
                            .trimmingCharacters(
                                in: .whitespacesAndNewlines
                            )
                            .isEmpty
                )
            }
        }
        .sheet(isPresented: $showingScanner) {
            NavigationStack {
                QRCodeScannerView { code in
                    store.pairingPayload = code
                    showingScanner = false
                    Task {
                        await store.pairFromPayload()
                    }
                } onError: { message in
                    scannerError = message
                    showingScanner = false
                }
                .ignoresSafeArea()
                .navigationTitle("Scan Pairing QR")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(
                        placement: .cancellationAction
                    ) {
                        Button("Cancel") {
                            showingScanner = false
                        }
                    }
                }
            }
        }
    }
}

private struct SessionRow: View {
    let session: RemoteSession

    var body: some View {
        HStack(spacing: 12) {
            Image(
                systemName: session.inputRequired
                    ? "exclamationmark.bubble.fill"
                    : "terminal"
            )
            .font(.title3)
            .frame(width: 28)

            VStack(alignment: .leading, spacing: 3) {
                Text(session.name ?? session.cwd)
                    .font(.headline)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    Circle()
                        .frame(width: 7, height: 7)
                        .foregroundStyle(
                            session.relayConnected
                                ? .green
                                : .secondary
                        )
                    Text(session.model ?? "No model")
                    Text("·")
                    Text(session.cwd)
                        .lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct SessionDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let session: RemoteSession
    let startFresh: Bool

    @State private var editorResponse = ""
    @State private var showingModelPicker = false
    @State private var showingThinkingPicker = false
    @State private var showingCommands = false
    @State private var commandResult: PiCommandResultPayload?
    @State private var commandNotice: String?
    @State private var performanceMonitor =
        ConversationPerformanceMonitor()

    var body: some View {
        @Bindable var store = store

        VStack(spacing: 0) {
            statusBar

            Divider()

            ScrollView {
                LazyVStack(
                    alignment: .leading,
                    spacing: 12
                ) {
                    if store.isOpeningSession,
                       store.rpcSnapshot?.messages.isEmpty ?? true {
                        ProgressView("Opening Pi Agent…")
                            .frame(maxWidth: .infinity)
                            .padding()
                    }

                    if let error = store.sessionError {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }

                    if let snapshot = store.rpcSnapshot {
                        ConversationTranscriptView(
                            snapshot: snapshot
                        )

                        if let request = snapshot.uiRequest {
                            InteractiveRequestCard(
                                request: request,
                                editorResponse: $editorResponse
                            )
                        }
                    }
                }
                .padding()
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(
                TapGesture().onEnded {
                    dismissKeyboard()
                }
            )
            .simultaneousGesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { _ in
                        performanceMonitor.beginDragging()
                    }
                    .onEnded { _ in
                        performanceMonitor.endDragging()
                    }
            )
            .onAppear {
                performanceMonitor.start { report in
                    await store.reportPerformance(report)
                }
            }
            .onDisappear {
                performanceMonitor.stop()
            }
            .onChange(
                of: store.rpcSnapshot?.presentationRevision
            ) { _, _ in
                guard let snapshot = store.rpcSnapshot else {
                    return
                }
                performanceMonitor.recordSnapshot(
                    liveCharacters: snapshot.liveCharacterCount,
                    isStreaming: snapshot.state?
                        .objectValue?["isStreaming"]?
                        .boolValue ?? false
                )
            }

            Divider()

            VStack(spacing: 0) {
                if !slashSuggestions.isEmpty {
                    SlashCommandSuggestionsView(
                        commands: slashSuggestions
                    ) { command in
                        selectSlashCommand(command)
                    }

                    Divider()
                }

                if let commandNotice {
                    Text(commandNotice)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                }

                HStack(alignment: .bottom, spacing: 10) {
                    TextField(
                        "Message Pi",
                        text: $store.composerText,
                        axis: .vertical
                    )
                    .lineLimit(1...6)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.quaternary)
                    .clipShape(
                        RoundedRectangle(cornerRadius: 20)
                    )

                    Button {
                        Task {
                            if sendButtonIsAbort {
                                await store.abort()
                            } else {
                                await submitComposer()
                            }
                        }
                    } label: {
                        Image(
                            systemName: sendButtonIsAbort
                                ? "stop.fill"
                                : "arrow.up"
                        )
                        .font(
                            .system(
                                size: 15,
                                weight: .bold
                            )
                        )
                        .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.circle)
                    .disabled(
                        sendButtonIsAbort
                            ? !canWrite
                            : !canSend
                    )
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .background(.bar)
        }
        .navigationTitle(conversationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingModelPicker = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "cpu")
                        Text(currentModelLabel)
                            .lineLimit(1)
                    }
                }
                .disabled(
                    isStreaming
                        || store.isResumingSession
                        || (store.rpcSnapshot?
                            .availableModels.isEmpty ?? true)
                )
            }

        }
        .sheet(isPresented: $showingModelPicker) {
            ModelPickerView()
        }
        .sheet(isPresented: $showingThinkingPicker) {
            PiThinkingPickerView(
                levels: store.rpcSnapshot?
                    .availableThinkingLevels ?? [],
                current: currentThinkingLevel
            ) { level in
                Task {
                    await store.setThinkingLevel(level)
                }
            }
        }
        .sheet(isPresented: $showingCommands) {
            PiCommandBrowserView(
                commands: allSlashCommands
            ) { command in
                selectSlashCommand(command)
            }
        }
        .sheet(item: $commandResult) { payload in
            PiCommandResultView(payload: payload)
        }
        .task(
            id: session.instanceId
                + (startFresh ? "-fresh" : "-existing")
        ) {
            if startFresh {
                await store.createNewSession(from: session)
            } else {
                await store.openSession(session)
            }
        }
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private var conversationTitle: String {
        if let name = store.rpcSnapshot?
            .state?
            .objectValue?["sessionName"]?
            .stringValue,
           !name.isEmpty {
            return name
        }

        return startFresh
            ? "New Session"
            : (session.name ?? "Pi Session")
    }

    private var currentModelLabel: String {
        guard let model = store.rpcSnapshot?
            .state?
            .objectValue?["model"]?
            .objectValue
        else {
            return "Model"
        }

        return model["name"]?.stringValue
            ?? model["id"]?.stringValue
            ?? "Model"
    }

    private var isStreaming: Bool {
        store.rpcSnapshot?
            .state?
            .objectValue?["isStreaming"]?
            .boolValue ?? false
    }

    private var canWrite: Bool {
        guard let snapshot = store.rpcSnapshot else {
            return false
        }
        return snapshot.phase == .live
            && !snapshot.readOnly
            && !store.isResumingSession
    }

    private var canSend: Bool {
        canWrite
            && !store.composerText
                .trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                .isEmpty
    }

    private var sendButtonIsAbort: Bool {
        isStreaming && !composerIsSlashCommand
    }

    private var composerIsSlashCommand: Bool {
        store.composerText
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .hasPrefix("/")
    }

    private var currentThinkingLevel: String? {
        store.rpcSnapshot?
            .state?
            .objectValue?["thinkingLevel"]?
            .stringValue
    }

    private var allSlashCommands: [PiSlashCommandOption] {
        var seen = Set<String>()
        var result: [PiSlashCommandOption] = []

        for command in PiSlashCommandOption.remoteBuiltins
            + (store.rpcSnapshot?.availableCommands ?? []) {
            let key = command.name.lowercased()
            guard seen.insert(key).inserted else { continue }
            result.append(command)
        }

        return result.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name)
                == .orderedAscending
        }
    }

    private var slashSuggestions: [PiSlashCommandOption] {
        let text = store.composerText
        guard text.hasPrefix("/") else { return [] }

        let body = String(text.dropFirst())
        guard !body.contains(where: { $0.isWhitespace }) else {
            return []
        }

        let query = body.lowercased()
        return Array(
            allSlashCommands
                .filter {
                    query.isEmpty
                        || $0.name.lowercased().hasPrefix(query)
                }
                .prefix(8)
        )
    }

    private func selectSlashCommand(
        _ command: PiSlashCommandOption
    ) {
        commandNotice = nil
        store.composerText = command.invocation + " "
    }

    private func submitComposer() async {
        let text = store.composerText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        guard text.hasPrefix("/") else {
            commandNotice = nil
            await store.sendPrompt()
            return
        }

        let commandText = String(text.dropFirst())
        let pieces = commandText.split(
            maxSplits: 1,
            whereSeparator: { $0.isWhitespace }
        )
        guard let first = pieces.first else { return }

        let name = first.lowercased()
        let arguments = pieces.count > 1
            ? String(pieces[1]).trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            : ""

        if PiSlashCommandOption.adaptedBuiltinNames.contains(name) {
            if isStreaming,
               !["copy", "commands", "help"].contains(name) {
                commandNotice = "Finish or stop the current Pi run before using /\(name)."
                return
            }

            switch name {
            case "model":
                store.composerText = ""
                commandNotice = nil
                showingModelPicker = true

            case "thinking":
                if arguments.isEmpty {
                    store.composerText = ""
                    commandNotice = nil
                    showingThinkingPicker = true
                } else if store.rpcSnapshot?
                    .availableThinkingLevels
                    .contains(arguments) == true {
                    store.composerText = ""
                    await store.setThinkingLevel(arguments)
                    commandNotice = "Thinking level: \(arguments)"
                } else {
                    let levels = store.rpcSnapshot?
                        .availableThinkingLevels
                        .joined(separator: ", ") ?? ""
                    commandNotice = levels.isEmpty
                        ? "Pi did not report available thinking levels."
                        : "Thinking levels: \(levels)"
                }

            case "compact":
                store.composerText = ""
                let result = await store.compactContext(
                    arguments.isEmpty ? nil : arguments
                )
                if result != nil {
                    commandNotice = "Context compacted."
                }

            case "name":
                guard !arguments.isEmpty else {
                    commandNotice = "Usage: /name <session name>"
                    return
                }
                store.composerText = ""
                if await store.setSessionName(arguments) {
                    commandNotice = "Session renamed."
                }

            case "session":
                store.composerText = ""
                if let value = await store.fetchSessionStats() {
                    commandResult = PiCommandResultPayload(
                        title: "Session",
                        value: value
                    )
                }

            case "copy":
                store.composerText = ""
                if let value = await store.fetchLastAssistantText(),
                   !value.isEmpty {
                    UIPasteboard.general.string = value
                    commandNotice = "Copied the last assistant response."
                } else {
                    commandNotice = "There is no assistant response to copy."
                }

            case "resume":
                store.composerText = ""
                dismiss()

            case "new":
                store.composerText = ""
                await store.createNewSession(from: session)
                commandNotice = "Started a fresh Pi session."

            case "commands", "help":
                store.composerText = ""
                commandNotice = nil
                showingCommands = true

            default:
                break
            }
            return
        }

        if PiSlashCommandOption.knownTUIBuiltins.contains(name) {
            commandNotice = "/\(name) is a Pi TUI command that Pi Remote has not adapted yet."
            return
        }

        // Extension commands, prompt templates and skills are discovered from
        // Pi's get_commands RPC and intentionally pass through as /... prompt
        // text so Pi performs its own expansion/dispatch.
        commandNotice = nil
        await store.sendPrompt()
    }

    @ViewBuilder
    private var statusBar: some View {
        if let snapshot = store.rpcSnapshot {
            HStack {
                Circle()
                    .frame(width: 8, height: 8)
                    .foregroundStyle(
                        store.isResumingSession
                            ? .orange
                            : (snapshot.phase == .live
                                ? .green
                                : .orange)
                    )

                if store.isResumingSession {
                    ProgressView()
                        .controlSize(.small)
                    Text("Reconnecting…")
                } else {
                    Text(snapshot.phase.rawValue.capitalized)
                }

                if snapshot.readOnly {
                    Text("Read only")
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if let state = snapshot.state?.objectValue,
                   let streaming = state["isStreaming"]?.boolValue,
                   streaming {
                    ProgressView()
                        .controlSize(.small)
                    Text("Pi running")
                        .font(.caption)
                }
            }
            .font(.caption)
            .padding(.horizontal)
            .padding(.vertical, 8)
        } else {
            HStack {
                ProgressView()
                    .controlSize(.small)
                Text("Joining…")
            }
            .font(.caption)
            .padding(8)
        }
    }

    private func entryTitle(_ entry: JSONValue) -> String {
        guard let object = entry.objectValue else {
            return "Entry"
        }

        if let role = object["role"]?.stringValue {
            return role.capitalized
        }

        return object["type"]?.stringValue ?? "Message"
    }
}

private struct ModelPickerView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(providers, id: \.self) { provider in
                    Section(provider) {
                        ForEach(
                            modelsByProvider[provider] ?? []
                        ) { model in
                            Button {
                                Task {
                                    await store.selectModel(model)
                                    dismiss()
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(
                                        alignment: .leading,
                                        spacing: 3
                                    ) {
                                        Text(model.displayName)
                                            .foregroundStyle(.primary)

                                        Text(model.modelId)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }

                                    Spacer()

                                    if isSelected(model) {
                                        Image(
                                            systemName: "checkmark"
                                        )
                                        .foregroundStyle(Color.accentColor)
                                    }
                                }
                            }
                        }
                    }
                }

                if filteredModels.isEmpty {
                    ContentUnavailableView.search(
                        text: query
                    )
                }
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                prompt: "Search models"
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
    }

    private var filteredModels: [PiModelOption] {
        let models = store.rpcSnapshot?.availableModels ?? []
        let trimmed = query.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !trimmed.isEmpty else {
            return models
        }

        return models.filter { model in
            model.displayName.localizedCaseInsensitiveContains(
                trimmed
            )
                || model.modelId.localizedCaseInsensitiveContains(
                    trimmed
                )
                || model.provider.localizedCaseInsensitiveContains(
                    trimmed
                )
        }
    }

    private var modelsByProvider: [String: [PiModelOption]] {
        Dictionary(
            grouping: filteredModels,
            by: \.provider
        )
    }

    private var providers: [String] {
        modelsByProvider.keys.sorted {
            $0.localizedCaseInsensitiveCompare($1)
                == .orderedAscending
        }
    }

    private func isSelected(_ model: PiModelOption) -> Bool {
        guard let current = store.rpcSnapshot?
            .state?
            .objectValue?["model"]?
            .objectValue
        else {
            return false
        }

        return current["provider"]?.stringValue == model.provider
            && current["id"]?.stringValue == model.modelId
    }
}

private struct InteractiveRequestCard: View {
    @Environment(AppStore.self) private var store

    let request: JSONValue
    @Binding var editorResponse: String

    var body: some View {
        let object = request.objectValue ?? [:]
        let method = object["method"]?.stringValue ?? "request"
        let title = object["title"]?.stringValue ?? "Pi needs input"
        let requestId = object["id"]?.stringValue

        VStack(alignment: .leading, spacing: 10) {
            Label(
                title,
                systemImage: "questionmark.bubble.fill"
            )
            .font(.headline)

            if let message = object["message"]?.stringValue {
                Text(message)
                    .font(.callout)
            }

            if method == "select",
               let values = object["options"]?.arrayValue,
               let requestId {
                ForEach(
                    Array(values.enumerated()),
                    id: \.offset
                ) { _, option in
                    if let value = option.stringValue {
                        Button(value) {
                            Task {
                                await store.answerInteractiveRequest(
                                    id: requestId,
                                    method: method,
                                    value: value
                                )
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }

                Button("Cancel") {
                    Task {
                        await store.answerInteractiveRequest(
                            id: requestId,
                            method: method,
                            value: nil
                        )
                    }
                }
                .buttonStyle(.bordered)

            } else if method == "confirm", let requestId {
                HStack {
                    Button("Confirm") {
                        Task {
                            await store.answerInteractiveRequest(
                                id: requestId,
                                method: method,
                                value: nil,
                                confirmed: true
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Cancel") {
                        Task {
                            await store.answerInteractiveRequest(
                                id: requestId,
                                method: method,
                                value: nil,
                                confirmed: false
                            )
                        }
                    }
                    .buttonStyle(.bordered)
                }

            } else if (method == "editor" || method == "input"),
                      let requestId {
                TextField(
                    object["placeholder"]?.stringValue ?? "Response",
                    text: $editorResponse,
                    axis: .vertical
                )
                .textFieldStyle(.roundedBorder)

                HStack {
                    Button("Submit") {
                        let value = editorResponse
                        editorResponse = ""
                        Task {
                            await store.answerInteractiveRequest(
                                id: requestId,
                                method: method,
                                value: value
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Cancel") {
                        editorResponse = ""
                        Task {
                            await store.answerInteractiveRequest(
                                id: requestId,
                                method: method,
                                value: nil
                            )
                        }
                    }
                    .buttonStyle(.bordered)
                }

            } else {
                DisclosureGroup("Request details") {
                    Text(
                        ChatMessageParser.prettyJSON(request)
                    )
                    .font(
                        .system(
                            .caption,
                            design: .monospaced
                        )
                    )
                    .textSelection(.enabled)
                    .padding(.top, 4)
                }
            }
        }
        .padding()
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct WireCard: View {
    let title: String
    let value: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)

            Text(prettyJSON(value))
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(
                    maxWidth: .infinity,
                    alignment: .leading
                )
        }
        .padding()
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private func prettyJSON(_ value: JSONValue) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let object = try? JSONSerialization.jsonObject(with: data),
          let pretty = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.prettyPrinted, .sortedKeys]
          ),
          let text = String(data: pretty, encoding: .utf8)
    else {
        return String(describing: value)
    }

    return text
}
