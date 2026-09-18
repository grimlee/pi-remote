import PiRemoteCore
import SwiftUI
import UIKit

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Pi Remote")
                .navigationDestination(for: RemoteSession.self) { session in
                    SessionDetailView(session: session)
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
                            NavigationLink(value: session) {
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
}

private struct PairingView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store

        Form {
            Section {
                Text(
                    "On the computer running pi-remote-host, run npm run pair, then paste the one-time payload below."
                )
                .font(.callout)
                .foregroundStyle(.secondary)

                TextEditor(text: $store.pairingPayload)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 150)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Button("Paste from Clipboard") {
                    if let value = UIPasteboard.general.string {
                        store.pairingPayload = value
                    }
                }
            } header: {
                Text("One-time pairing")
            }

            if let pairingError = store.pairingError {
                Section {
                    Text(pairingError)
                        .foregroundStyle(.red)
                }
            }

            Section {
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
                                : "Pair this iPhone"
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
    let session: RemoteSession

    @State private var editorResponse = ""

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
                    if store.isOpeningSession {
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

            Divider()

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
                        if isStreaming {
                            await store.abort()
                        } else {
                            await store.sendPrompt()
                        }
                    }
                } label: {
                    Image(
                        systemName: isStreaming
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
                    isStreaming
                        ? !canWrite
                        : !canSend
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.bar)
        }
        .navigationTitle(session.name ?? "Pi Session")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: session.instanceId) {
            await store.openSession(session)
        }
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
        return snapshot.phase == .live && !snapshot.readOnly
    }

    private var canSend: Bool {
        canWrite
            && !store.composerText
                .trimmingCharacters(
                    in: .whitespacesAndNewlines
                )
                .isEmpty
    }

    @ViewBuilder
    private var statusBar: some View {
        if let snapshot = store.rpcSnapshot {
            HStack {
                Circle()
                    .frame(width: 8, height: 8)
                    .foregroundStyle(
                        snapshot.phase == .live
                            ? .green
                            : .orange
                    )
                Text(snapshot.phase.rawValue.capitalized)

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
