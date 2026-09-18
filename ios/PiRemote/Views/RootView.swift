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
                    Text("Connected, but no active Pi Collab sessions were found.")
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
                        ProgressView("Joining Pi Collab…")
                            .frame(maxWidth: .infinity)
                            .padding()
                    }

                    if let error = store.sessionError {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }

                    if let snapshot = store.collabSnapshot {
                        ForEach(
                            Array(snapshot.entries.enumerated()),
                            id: \.offset
                        ) { _, entry in
                            WireCard(
                                title: entryTitle(entry),
                                value: entry
                            )
                        }

                        if let event = snapshot.lastEvent {
                            WireCard(
                                title: "Live event",
                                value: event
                            )
                        }

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

            Divider()

            HStack(spacing: 8) {
                TextField(
                    "Send a prompt to Pi…",
                    text: $store.composerText,
                    axis: .vertical
                )
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)

                Button("Send") {
                    Task {
                        await store.sendPrompt()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canWrite)

                Button {
                    Task {
                        await store.abort()
                    }
                } label: {
                    Image(systemName: "stop.fill")
                }
                .buttonStyle(.bordered)
                .disabled(!canWrite)
            }
            .padding()
        }
        .navigationTitle(session.name ?? "Pi Session")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: session.instanceId) {
            await store.openSession(session)
        }
    }

    private var canWrite: Bool {
        guard let snapshot = store.collabSnapshot else {
            return false
        }
        return snapshot.phase == .live && !snapshot.readOnly
    }

    @ViewBuilder
    private var statusBar: some View {
        if let snapshot = store.collabSnapshot {
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

        if let message = object["message"]?.objectValue,
           let role = message["role"]?.stringValue {
            return role.capitalized
        }

        return object["type"]?.stringValue ?? "Entry"
    }
}

private struct InteractiveRequestCard: View {
    @Environment(AppStore.self) private var store

    let request: JSONValue
    @Binding var editorResponse: String

    var body: some View {
        let object = request.objectValue ?? [:]
        let kind = object["kind"]?.stringValue ?? "request"
        let title = object["title"]?.stringValue
            ?? "Pi needs input"
        let reqId = object["reqId"]?.integerValue
            .flatMap(Int.init(exactly:))

        VStack(alignment: .leading, spacing: 10) {
            Label(
                title,
                systemImage: "questionmark.bubble.fill"
            )
            .font(.headline)

            if kind == "select",
               let values = object["options"]?.arrayValue {
                ForEach(
                    Array(values.enumerated()),
                    id: \.offset
                ) { _, option in
                    if let value = option.stringValue,
                       let reqId {
                        Button(value) {
                            Task {
                                await store.answerInteractiveRequest(
                                    reqId: reqId,
                                    value: value
                                )
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                }
            } else if kind == "editor", let reqId {
                TextField(
                    "Response",
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
                                reqId: reqId,
                                value: value
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Cancel") {
                        editorResponse = ""
                        Task {
                            await store.answerInteractiveRequest(
                                reqId: reqId,
                                value: nil
                            )
                        }
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                Text(prettyJSON(request))
                    .font(.system(.caption, design: .monospaced))
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
