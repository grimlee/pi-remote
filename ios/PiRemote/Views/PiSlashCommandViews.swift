import Foundation
import PiRemoteCore
import SwiftUI

struct SlashCommandSuggestionsView: View {
    let commands: [PiSlashCommandOption]
    let onSelect: (PiSlashCommandOption) -> Void

    var body: some View {
        if !commands.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(commands) { command in
                        Button {
                            onSelect(command)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(command.invocation)
                                    .font(.system(.callout, design: .monospaced))
                                    .foregroundStyle(.primary)

                                VStack(alignment: .leading, spacing: 2) {
                                    if !command.commandDescription.isEmpty {
                                        Text(command.commandDescription)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }

                                    Text(command.source.label)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }

                                Spacer()
                            }
                            .contentShape(Rectangle())
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 220)
            .background(.bar)
        }
    }
}

struct PiCommandBrowserView: View {
    @Environment(\.dismiss) private var dismiss

    let commands: [PiSlashCommandOption]
    let onSelect: (PiSlashCommandOption) -> Void

    @State private var query = ""

    var body: some View {
        NavigationStack {
            List(filteredCommands) { command in
                Button {
                    onSelect(command)
                    dismiss()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(command.invocation)
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(.primary)

                            Spacer()

                            Text(command.source.label)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        if !command.commandDescription.isEmpty {
                            Text(command.commandDescription)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .navigationTitle("Pi Commands")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search commands")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
    }

    private var filteredCommands: [PiSlashCommandOption] {
        let trimmed = query.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !trimmed.isEmpty else {
            return commands
        }

        return commands.filter { command in
            command.name.localizedCaseInsensitiveContains(trimmed)
                || command.commandDescription
                    .localizedCaseInsensitiveContains(trimmed)
                || command.source.label
                    .localizedCaseInsensitiveContains(trimmed)
        }
    }
}

struct PiThinkingPickerView: View {
    @Environment(\.dismiss) private var dismiss

    let levels: [String]
    let current: String?
    let onSelect: (String) -> Void

    var body: some View {
        NavigationStack {
            List(levels, id: \.self) { level in
                Button {
                    onSelect(level)
                    dismiss()
                } label: {
                    HStack {
                        Text(level.capitalized)
                            .foregroundStyle(.primary)

                        Spacer()

                        if level == current {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
            .navigationTitle("Thinking")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
    }
}

struct PiCommandResultPayload: Identifiable {
    let id = UUID()
    let title: String
    let value: JSONValue
}

struct PiCommandResultView: View {
    @Environment(\.dismiss) private var dismiss

    let payload: PiCommandResultPayload

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(ChatMessageParser.prettyJSON(payload.value))
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(payload.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}
