import Foundation
import SwiftUI
import UIKit

struct ConversationTranscriptView: View {
    let snapshot: PiRpcSnapshot
    let showAgentActivity: Bool

    @State private var parsedMessages: [ChatMessage]
    @State private var parsedRevision: Int

    init(
        snapshot: PiRpcSnapshot,
        showAgentActivity: Bool
    ) {
        self.snapshot = snapshot
        self.showAgentActivity = showAgentActivity
        _parsedMessages = State(
            initialValue: ChatMessageParser.parseAll(
                snapshot.messages
            )
        )
        _parsedRevision = State(
            initialValue: snapshot.messageRevision
        )
    }

    var body: some View {
        Group {
            ForEach(
                Array(parsedMessages.enumerated()),
                id: \.offset
            ) { _, message in
                if let presented = presentedMessage(
                    message,
                    isStreaming: false
                ) {
                    ConversationMessageRow(
                        message: presented,
                        isStreaming: false
                    )
                }
            }

            if let live = snapshot.liveMessage,
               let message = ChatMessageParser.parse(live),
               let presented = presentedMessage(
                    message,
                    isStreaming: true
               ) {
                ConversationMessageRow(
                    message: presented,
                    isStreaming: true
                )
            }
        }
        .onChange(of: snapshot.messageRevision) { _, revision in
            guard parsedRevision != revision else { return }

            parsedMessages = ChatMessageParser.parseAll(
                snapshot.messages
            )
            parsedRevision = revision
        }
    }

    private func presentedMessage(
        _ message: ChatMessage,
        isStreaming: Bool
    ) -> ChatMessage? {
        guard !showAgentActivity else { return message }

        switch message.role {
        case .tool:
            return nil

        case .assistant:
            let visibleBlocks = message.blocks.compactMap {
                block -> ChatMessageBlock? in
                switch block {
                case let .text(text):
                    return text.isEmpty ? nil : .text(text)
                case let .image(label):
                    return .image(label: label)
                case .thinking, .toolCall, .raw:
                    return nil
                }
            }

            guard !visibleBlocks.isEmpty else {
                return nil
            }

            return ChatMessage(
                role: message.role,
                timestamp: message.timestamp,
                blocks: visibleBlocks,
                toolName: message.toolName,
                isError: message.isError
            )

        case .user, .system:
            return message
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
                    foreground: .white,
                    isStreaming: false
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
                    foreground: .primary,
                    isStreaming: isStreaming
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
                foreground: .secondary,
                isStreaming: false
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
    let isStreaming: Bool

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
                        foreground: foreground,
                        isStreaming: isStreaming
                    )

                case let .thinking(thinking):
                    DisclosureGroup {
                        if isStreaming {
                            Text(thinking)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .padding(.top, 4)
                        } else {
                            Text(thinking)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .padding(.top, 4)
                        }
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
                foreground: .primary,
                isStreaming: false
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
    let isStreaming: Bool

    var body: some View {
        if isStreaming {
            // TextKit is much better suited to a long append-only stream than
            // replacing one increasingly-large SwiftUI Text value. The
            // representable appends only the new UTF-16 suffix to textStorage,
            // allowing TextKit to keep the already-laid-out prefix stable
            // while the user scrolls through a long response.
            StreamingPlainTextView(text: text)
        } else {
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
}

private struct StreamingPlainTextView: UIViewRepresentable {
    let text: String

    final class Coordinator {
        var renderedText = ""
        var renderedUTF16Length = 0
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.backgroundColor = .clear
        view.isEditable = false
        view.isSelectable = false
        view.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.setContentCompressionResistancePriority(
            .defaultLow,
            for: .horizontal
        )
        view.setContentHuggingPriority(
            .defaultLow,
            for: .horizontal
        )
        return view
    }

    func updateUIView(
        _ uiView: UITextView,
        context: Context
    ) {
        let coordinator = context.coordinator
        let newText = text as NSString
        let oldLength = coordinator.renderedUTF16Length

        if oldLength > 0,
           newText.length >= oldLength,
           newText.substring(to: oldLength)
                == coordinator.renderedText {
            let delta = newText.substring(from: oldLength)
            if !delta.isEmpty {
                uiView.textStorage.append(
                    NSAttributedString(
                        string: delta,
                        attributes: textAttributes(for: uiView)
                    )
                )
                coordinator.renderedText += delta
                coordinator.renderedUTF16Length = newText.length
                uiView.invalidateIntrinsicContentSize()
            }
            return
        }

        uiView.attributedText = NSAttributedString(
            string: text,
            attributes: textAttributes(for: uiView)
        )
        coordinator.renderedText = text
        coordinator.renderedUTF16Length = newText.length
        uiView.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width,
              width.isFinite,
              width > 0
        else {
            return nil
        }

        let measured = uiView.sizeThatFits(
            CGSize(
                width: width,
                height: .greatestFiniteMagnitude
            )
        )
        return CGSize(
            width: width,
            height: ceil(measured.height)
        )
    }

    private func textAttributes(
        for view: UITextView
    ) -> [NSAttributedString.Key: Any] {
        [
            .font: view.font
                ?? UIFont.preferredFont(forTextStyle: .body),
            .foregroundColor: view.textColor ?? UIColor.label
        ]
    }
}
