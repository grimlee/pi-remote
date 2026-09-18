import Foundation
import SwiftUI
import UIKit

struct ConversationTranscriptView: View {
    let snapshot: PiRpcSnapshot

    var body: some View {
        let messages = ChatMessageParser.parseAll(snapshot.messages)

        ForEach(
            Array(messages.enumerated()),
            id: \.offset
        ) { _, message in
            ConversationMessageRow(
                message: message,
                isStreaming: false
            )
        }

        if let live = snapshot.liveMessage,
           let message = ChatMessageParser.parse(live) {
            ConversationMessageRow(
                message: message,
                isStreaming: true
            )
        }
    }
}

private struct ConversationMessageRow: View {
    let message: ChatMessage
    let isStreaming: Bool

    var body: some View {
        switch message.role {
        case .user:
            HStack(alignment: .bottom) {
                Spacer(minLength: 48)

                MessageBlocks(
                    blocks: message.blocks,
                    foreground: .white
                )
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.accentColor)
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }

        case .assistant:
            VStack(alignment: .leading, spacing: 8) {
                MessageBlocks(
                    blocks: message.blocks,
                    foreground: .primary
                )

                if isStreaming {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.mini)
                        Text("Pi is responding")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .frame(
                maxWidth: .infinity,
                alignment: .leading
            )

        case .tool:
            ToolResultCard(message: message)

        case .system:
            MessageBlocks(
                blocks: message.blocks,
                foreground: .secondary
            )
            .padding(12)
            .frame(
                maxWidth: .infinity,
                alignment: .leading
            )
            .background(.quaternary)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

private struct MessageBlocks: View {
    let blocks: [ChatMessageBlock]
    let foreground: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(
                Array(blocks.enumerated()),
                id: \.offset
            ) { _, block in
                switch block {
                case let .text(text):
                    MarkdownMessageText(
                        text: text,
                        foreground: foreground
                    )

                case let .thinking(thinking):
                    DisclosureGroup {
                        Text(thinking)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .padding(.top, 4)
                    } label: {
                        Label(
                            "Reasoning",
                            systemImage: "brain"
                        )
                        .font(.caption)
                    }
                    .tint(foreground)

                case let .toolCall(name, arguments):
                    DisclosureGroup {
                        if !arguments.isEmpty {
                            Text(arguments)
                                .font(
                                    .system(
                                        .caption,
                                        design: .monospaced
                                    )
                                )
                                .textSelection(.enabled)
                                .padding(.top, 4)
                        }
                    } label: {
                        Label(
                            name,
                            systemImage: "wrench.and.screwdriver"
                        )
                        .font(.caption)
                    }
                    .tint(foreground)

                case let .image(label):
                    Label(
                        label,
                        systemImage: "photo"
                    )
                    .font(.callout)

                case let .raw(value):
                    DisclosureGroup("Details") {
                        Text(
                            ChatMessageParser.prettyJSON(value)
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
                    .font(.caption)
                    .tint(foreground)
                }
            }
        }
        .foregroundStyle(foreground)
    }
}

private struct ToolResultCard: View {
    let message: ChatMessage

    var body: some View {
        DisclosureGroup {
            MessageBlocks(
                blocks: message.blocks,
                foreground: .primary
            )
            .padding(.top, 8)
        } label: {
            HStack(spacing: 8) {
                Image(
                    systemName: message.isError
                        ? "exclamationmark.triangle.fill"
                        : "checkmark.circle"
                )
                .foregroundStyle(
                    message.isError
                        ? .red
                        : .secondary
                )

                Text(message.toolName ?? "Tool")
                    .font(.callout.weight(.medium))
            }
        }
        .padding(12)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct MarkdownMessageText: View {
    let text: String
    let foreground: Color

    var body: some View {
        Group {
            if let attributed = try? AttributedString(
                markdown: text
            ) {
                Text(attributed)
            } else {
                Text(text)
            }
        }
        .foregroundStyle(foreground)
        .textSelection(.enabled)
    }
}
