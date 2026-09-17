import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            Group {
                if store.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("No Pi sessions", systemImage: "desktopcomputer")
                    } description: {
                        Text(emptyStateMessage)
                    } actions: {
                        if case .unpaired = store.connectionState {
                            Button("Pair a computer") {
                                // Pairing flow is the next vertical-slice milestone.
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                } else {
                    List(store.sessions) { session in
                        NavigationLink(value: session) {
                            SessionRow(session: session)
                        }
                    }
                    .navigationDestination(for: RemoteSession.self) { session in
                        Text(session.name ?? session.cwd)
                            .navigationTitle(session.name ?? "Pi Session")
                    }
                }
            }
            .navigationTitle("Pi Remote")
        }
    }

    private var emptyStateMessage: String {
        switch store.connectionState {
        case .unpaired:
            return "Pair this iPhone with the computer that runs Pi."
        case .connecting:
            return "Connecting to your computer…"
        case .connected:
            return "The computer is online, but it is not currently sharing a Pi session."
        case .disconnected:
            return "Your paired computer is currently unreachable."
        }
    }
}

private struct SessionRow: View {
    let session: RemoteSession

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: session.inputRequired ? "exclamationmark.bubble.fill" : "terminal")
                .font(.title3)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 3) {
                Text(session.name ?? session.cwd)
                    .font(.headline)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    Circle()
                        .frame(width: 7, height: 7)
                        .foregroundStyle(session.relayConnected ? .green : .secondary)
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
