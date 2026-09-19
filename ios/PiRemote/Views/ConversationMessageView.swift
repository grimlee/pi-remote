import Foundation
import SwiftUI
import UIKit

struct ConversationTranscriptView: View {
    let snapshot: PiRpcSnapshot

    @State private var parsedMessages: [ChatMessage]
    @State private var parsedRevision: Int

    init(snapshot: PiRpcSnapshot) {
        self.snapshot = snapshot
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
                Array(transcriptTurns.enumerated()),
                id: \.offset
            ) { _, turn in
                if let user = turn.user {
                    ConversationMessageRow(
                        message: user.message,
                        isStreaming: false
                    )
                }

                TurnResponseView(
                    responses: turn.responses
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

    private var transcriptTurns: [TranscriptTurn] {
        var entries = parsedMessages.map {
            TranscriptEntry(message: $0, isStreaming: false)
        }

        if let live = snapshot.liveMessage,
           let message = ChatMessageParser.parse(live) {
            entries.append(
                TranscriptEntry(message: message, isStreaming: true)
            )
        }

        var turns: [TranscriptTurn] = []
        var currentUser: TranscriptEntry?
        var currentResponses: [TranscriptEntry] = []

        func flush() {
            guard currentUser != nil || !currentResponses.isEmpty else {
                return
            }
            turns.append(
                TranscriptTurn(
                    user: currentUser,
                    responses: currentResponses
                )
            )
            currentUser = nil
            currentResponses = []
        }

        for entry in entries {
            if entry.message.role == .user {
                flush()
                currentUser = entry
            } else {
                currentResponses.append(entry)
            }
        }

        flush()
        return turns
    }
}

private struct TranscriptEntry {
    let message: ChatMessage
    let isStreaming: Bool
}

private struct TranscriptTurn {
    let user: TranscriptEntry?
    let responses: [TranscriptEntry]
}

private struct TurnResponseView: View {
    let responses: [TranscriptEntry]

    var body: some View {
        if !activityEntries.isEmpty {
            AgentActivityGroup(
                entries: activityEntries,
                isStreaming: isStreaming
            )
        }

        if let finalEntry {
            ConversationMessageRow(
                message: finalEntry.message,
                isStreaming: finalEntry.isStreaming
            )
        }
    }

    private var finalEntry: TranscriptEntry? {
        guard let last = responses.last,
              last.message.role == .assistant
        else {
            return nil
        }

        let visible = visibleAssistantBlocks(last.message.blocks)
        guard !visible.isEmpty else {
            return nil
        }

        return TranscriptEntry(
            message: ChatMessage(
                role: .assistant,
                timestamp: last.message.timestamp,
                blocks: visible,
                toolName: last.message.toolName,
                isError: last.message.isError
            ),
            isStreaming: last.isStreaming
        )
    }

    private var activityEntries: [TranscriptEntry] {
        var activity = responses

        if let last = responses.last,
           last.message.role == .assistant,
           !visibleAssistantBlocks(last.message.blocks).isEmpty {
            activity.removeLast()

            let hidden = activityAssistantBlocks(last.message.blocks)
            if !hidden.isEmpty {
                activity.append(
                    TranscriptEntry(
                        message: ChatMessage(
                            role: .assistant,
                            timestamp: last.message.timestamp,
                            blocks: hidden,
                            toolName: last.message.toolName,
                            isError: last.message.isError
                        ),
                        isStreaming: last.isStreaming
                    )
                )
            }
        }

        return activity.filter { !$0.message.blocks.isEmpty }
    }

    private var isStreaming: Bool {
        responses.contains(where: \.isStreaming)
    }

    private func visibleAssistantBlocks(
        _ blocks: [ChatMessageBlock]
    ) -> [ChatMessageBlock] {
        blocks.compactMap { block in
            switch block {
            case let .text(text):
                return text.isEmpty ? nil : .text(text)
            case let .image(label):
                return .image(label: label)
            case .thinking, .toolCall, .raw:
                return nil
            }
        }
    }

    private func activityAssistantBlocks(
        _ blocks: [ChatMessageBlock]
    ) -> [ChatMessageBlock] {
        blocks.compactMap { block in
            switch block {
            case .thinking, .toolCall, .raw:
                return block
            case .text, .image:
                return nil
            }
        }
    }
}

private struct AgentActivityGroup: View {
    let entries: [TranscriptEntry]
    let isStreaming: Bool

    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(
                    Array(entries.enumerated()),
                    id: \.offset
                ) { _, entry in
                    ConversationMessageRow(
                        message: entry.message,
                        isStreaming: entry.isStreaming
                    )
                }
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 8) {
                if isStreaming {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "checkmark.circle")
                        .foregroundStyle(.secondary)
                }

                Text(isStreaming ? "Working…" : "Agent activity")
                    .font(.callout.weight(.medium))

                Spacer()

                Text(activitySummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var activitySummary: String {
        let toolCount = entries.reduce(into: 0) { count, entry in
            if entry.message.role == .tool {
                count += 1
            }

            for block in entry.message.blocks {
                if case .toolCall = block {
                    count += 1
                }
            }
        }

        if toolCount > 0 {
            return "\(toolCount) tool step"
                + (toolCount == 1 ? "" : "s")
        }

        return entries.count == 1
            ? "1 step"
            : "\(entries.count) steps"
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
            // UX-01 A/B: keep every other main-branch behavior unchanged,
            // but bypass the growing non-scrollable UITextView/TextKit bridge.
            // This isolates whether repeated intrinsic-size measurement of the
            // live response is the dominant source of scroll hitching.
            Text(text)
                .foregroundStyle(foreground)
        } else {
            Group {
                if let attributed = try? AttributedString(
                    markdown: text,
                    options: AttributedString.MarkdownParsingOptions(
                        interpretedSyntax: .inlineOnlyPreservingWhitespace
                    )
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
