import Foundation
import SwiftUI
import UIKit

struct ConversationTranscriptView: View {
    @Environment(AppStore.self) private var store

    let snapshot: PiRpcSnapshot

    @State private var parsedMessages: [ChatMessage] = []
    @State private var parsedRevision = -1
    @State private var retainedLiveEntry: TranscriptEntry?
    @State private var retainedLiveRevision: Int?

    var body: some View {
        Group {
            // Always keep a concrete transcript subtree mounted, even before
            // async history parsing has produced its first turn. Historical
            // sessions begin with no live message; returning EmptyView here
            // can prevent the lazy stack from keeping this view alive long
            // enough for its revision task to populate parsedMessages.
            StableTranscriptTurnsView(
                turns: Array(stableTurns.dropLast()),
                revision: parsedRevision
            )
            .equatable()

            if let currentTurn = stableTurns.last {
                CurrentTranscriptTurnView(
                    turn: currentTurn,
                    liveEntry: presentationLiveEntry
                )
            } else if let presentationLiveEntry {
                CurrentTranscriptTurnView(
                    turn: TranscriptTurn(
                        user: nil,
                        responses: []
                    ),
                    liveEntry: presentationLiveEntry
                )
            }
        }
        .onChange(
            of: snapshot.liveMessage,
            initial: true
        ) { oldValue, newValue in
            if let newValue,
               let message = ChatMessageParser.parse(newValue) {
                retainedLiveEntry = TranscriptEntry(
                    message: message,
                    isStreaming: true
                )
                retainedLiveRevision = snapshot.messageRevision
            } else if let oldValue,
                      let message = ChatMessageParser.parse(oldValue) {
                // message_end moves the final assistant message from
                // liveMessage into messages before the async history parse has
                // caught up. Keep the last live renderer in place for that
                // short handoff so ScrollView never observes a huge temporary
                // content-height collapse.
                retainedLiveEntry = TranscriptEntry(
                    message: message,
                    isStreaming: true
                )
                retainedLiveRevision = snapshot.messageRevision
            }
        }
        .task(id: snapshot.messageRevision) {
            await refreshParsedHistory()
        }
    }

    private var liveEntry: TranscriptEntry? {
        guard let live = snapshot.liveMessage,
              let message = ChatMessageParser.parse(live)
        else {
            return nil
        }

        return TranscriptEntry(
            message: message,
            isStreaming: true
        )
    }

    private var presentationLiveEntry: TranscriptEntry? {
        if let liveEntry {
            return liveEntry
        }

        guard parsedRevision != snapshot.messageRevision,
              retainedLiveRevision == snapshot.messageRevision
        else {
            return nil
        }

        return retainedLiveEntry
    }

    private var stableTurns: [TranscriptTurn] {
        makeTranscriptTurns(
            parsedMessages.map {
                TranscriptEntry(
                    message: $0,
                    isStreaming: false
                )
            }
        )
    }

    private func refreshParsedHistory() async {
        let revision = snapshot.messageRevision
        guard revision != parsedRevision else {
            return
        }

        let values = snapshot.messages
        let startedAtMs = Int64(
            Date().timeIntervalSince1970 * 1_000
        )
        let startedAt = ProcessInfo.processInfo.systemUptime

        let parsed = await Task.detached(
            priority: .userInitiated
        ) {
            ChatMessageParser.parseAll(values)
        }.value

        guard !Task.isCancelled else {
            return
        }

        parsedMessages = parsed
        parsedRevision = revision

        if snapshot.liveMessage == nil,
           retainedLiveRevision == revision {
            retainedLiveEntry = nil
            retainedLiveRevision = nil
        }

        let durationMs = max(
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
        store.reportDiagnosticTiming(
            stage: "transcript.history",
            startedAtMs: startedAtMs,
            durationMs: durationMs,
            detail: "m=\(values.count)"
        )
    }
}

private struct StableTranscriptTurnsView: View, Equatable {
    let turns: [TranscriptTurn]
    let revision: Int

    nonisolated static func == (
        lhs: StableTranscriptTurnsView,
        rhs: StableTranscriptTurnsView
    ) -> Bool {
        lhs.revision == rhs.revision
            && lhs.turns.count == rhs.turns.count
    }

    var body: some View {
        ForEach(
            Array(turns.enumerated()),
            id: \.offset
        ) { _, turn in
            if let user = turn.user {
                ConversationMessageRow(
                    message: user.message,
                    isStreaming: false
                )
                .equatable()
            }

            TurnResponseView(
                responses: turn.responses
            )
        }
    }
}

private struct CurrentTranscriptTurnView: View {
    let turn: TranscriptTurn
    let liveEntry: TranscriptEntry?

    var body: some View {
        if let user = turn.user {
            ConversationMessageRow(
                message: user.message,
                isStreaming: false
            )
            .equatable()
        }

        TurnResponseView(
            responses: turn.responses
                + (liveEntry.map { [$0] } ?? [])
        )
    }
}

private func makeTranscriptTurns(
    _ entries: [TranscriptEntry]
) -> [TranscriptTurn] {
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

private struct TranscriptEntry: Equatable {
    let message: ChatMessage
    let isStreaming: Bool
}

private struct TranscriptTurn: Equatable {
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
            .equatable()
        }

        if let finalEntry {
            ConversationMessageRow(
                message: finalEntry.message,
                isStreaming: finalEntry.isStreaming
            )
            .equatable()
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

private struct AgentActivityGroup: View, Equatable {
    let entries: [TranscriptEntry]
    let isStreaming: Bool

    @State private var isExpanded = false

    nonisolated static func == (
        lhs: AgentActivityGroup,
        rhs: AgentActivityGroup
    ) -> Bool {
        lhs.entries == rhs.entries
            && lhs.isStreaming == rhs.isStreaming
    }

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

private struct ConversationMessageRow: View, Equatable {
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
            CompletedMarkdownText(
                text: text,
                foreground: foreground
            )
        }
    }
}

private struct CompletedMarkdownText: View {
    @Environment(AppStore.self) private var store

    let text: String
    let foreground: Color

    private let attributed: AttributedString?
    private let parseStartedAtMs: Int64
    private let parseDurationMs: Int
    private let constructedAt: TimeInterval
    private let characterCount: Int

    init(
        text: String,
        foreground: Color
    ) {
        let startedAt = ProcessInfo.processInfo.systemUptime
        let startedAtMs = Int64(
            Date().timeIntervalSince1970 * 1_000
        )
        let attributed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        )
        let durationMs = max(
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

        self.text = text
        self.foreground = foreground
        self.attributed = attributed
        self.parseStartedAtMs = startedAtMs
        self.parseDurationMs = durationMs
        self.constructedAt = startedAt
        self.characterCount = text.utf16.count
    }

    var body: some View {
        CompletedTextKitView(
            text: text,
            attributed: attributed,
            foreground: foreground
        )
        .onAppear {
            let appearDurationMs = max(
                0,
                Int(
                    (
                        (
                            ProcessInfo.processInfo.systemUptime
                                - constructedAt
                        ) * 1_000
                    ).rounded()
                )
            )

            guard characterCount >= 500
                || parseDurationMs >= 5
                || appearDurationMs >= 50
            else {
                return
            }

            store.reportDiagnosticTiming(
                stage: "markdown.appear",
                startedAtMs: parseStartedAtMs,
                durationMs: appearDurationMs,
                detail: "parse=\(parseDurationMs)|chars=\(characterCount)"
            )
        }
    }
}

private struct CompletedTextKitView: UIViewRepresentable {
    let text: String
    let attributed: AttributedString?
    let foreground: Color

    final class Coordinator {
        var renderedText = ""
        var renderedForeground: UIColor?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.backgroundColor = .clear
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.isUserInteractionEnabled = true
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
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
        let resolvedForeground = UIColor(foreground)
        let coordinator = context.coordinator

        guard coordinator.renderedText != text
            || coordinator.renderedForeground != resolvedForeground
        else {
            return
        }

        let rendered: NSMutableAttributedString
        if let attributed {
            rendered = NSMutableAttributedString(
                attributedString: NSAttributedString(attributed)
            )
        } else {
            rendered = NSMutableAttributedString(string: text)
        }

        let fullRange = NSRange(
            location: 0,
            length: rendered.length
        )
        if fullRange.length > 0 {
            rendered.addAttribute(
                .foregroundColor,
                value: resolvedForeground,
                range: fullRange
            )
            rendered.enumerateAttribute(
                .font,
                in: fullRange
            ) { value, range, _ in
                if value == nil {
                    rendered.addAttribute(
                        .font,
                        value: UIFont.preferredFont(
                            forTextStyle: .body
                        ),
                        range: range
                    )
                }
            }
        }

        uiView.attributedText = rendered
        coordinator.renderedText = text
        coordinator.renderedForeground = resolvedForeground
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
}

private struct StreamingPlainTextView: UIViewRepresentable {
    let text: String

    func makeUIView(
        context: Context
    ) -> StreamingChunkContainerView {
        let view = StreamingChunkContainerView()
        view.apply(text: text)
        return view
    }

    func updateUIView(
        _ uiView: StreamingChunkContainerView,
        context: Context
    ) {
        uiView.apply(text: text)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: StreamingChunkContainerView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width,
              width.isFinite,
              width > 0
        else {
            return nil
        }

        return CGSize(
            width: width,
            height: uiView.measuredHeight(for: width)
        )
    }
}

private final class StreamingChunkContainerView: UIView {
    // Keep live layout work bounded. Completed chunks never change again;
    // only the final ~2K-character chunk is remeasured as deltas arrive.
    private let targetChunkCharacters = 2_048
    private let minimumChunkCharacters = 1_024
    private let chunkLookaheadCharacters = 4_096
    private let boundarySampleUTF16Length = 64

    private var chunkTexts: [String] = []
    private var chunkViews: [UITextView] = []
    private var chunkHeights: [CGFloat?] = []
    private var renderedUTF16Length = 0
    private var renderedBoundarySample = ""
    private var measuredWidth: CGFloat?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        setContentCompressionResistancePriority(
            .defaultLow,
            for: .horizontal
        )
        setContentHuggingPriority(
            .defaultLow,
            for: .horizontal
        )
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func apply(text: String) {
        let newText = text as NSString
        let oldLength = renderedUTF16Length

        if oldLength > 0,
           newText.length >= oldLength,
           boundaryStillMatches(in: newText) {
            let delta = newText.substring(from: oldLength)
            if !delta.isEmpty {
                append(delta: delta)
            }
        } else if newText.length != oldLength
                    || !boundaryStillMatches(in: newText) {
            rebuild(from: text)
        }

        renderedUTF16Length = newText.length
        renderedBoundarySample = boundarySample(from: newText)
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    func measuredHeight(for width: CGFloat) -> CGFloat {
        guard width.isFinite, width > 0 else {
            return 0
        }

        if measuredWidth.map({
            abs($0 - width) > 0.5
        }) ?? true {
            measuredWidth = width
            chunkHeights = Array(
                repeating: nil,
                count: chunkViews.count
            )
        }

        var total: CGFloat = 0
        for index in chunkViews.indices {
            if let cached = chunkHeights[index] {
                total += cached
                continue
            }

            let measured = chunkViews[index].sizeThatFits(
                CGSize(
                    width: width,
                    height: .greatestFiniteMagnitude
                )
            )
            let height = ceil(measured.height)
            chunkHeights[index] = height
            total += height
        }
        return total
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let width = bounds.width
        guard width.isFinite, width > 0 else {
            return
        }

        _ = measuredHeight(for: width)

        var y: CGFloat = 0
        for index in chunkViews.indices {
            let height = chunkHeights[index] ?? 0
            chunkViews[index].frame = CGRect(
                x: 0,
                y: y,
                width: width,
                height: height
            )
            y += height
        }
    }

    private func append(delta: String) {
        if chunkTexts.isEmpty {
            appendChunk("")
        }

        var pending = chunkTexts[chunkTexts.count - 1]
            + delta
        var index = chunkTexts.count - 1

        while let split = splitIndexIfAvailable(
            in: pending
        ) {
            let fixed = String(pending[..<split])
            pending = String(pending[split...])

            setChunk(fixed, at: index)
            appendChunk("")
            index += 1
        }

        setChunk(pending, at: index)
    }

    private func rebuild(from text: String) {
        for view in chunkViews {
            view.removeFromSuperview()
        }
        chunkTexts.removeAll(keepingCapacity: true)
        chunkViews.removeAll(keepingCapacity: true)
        chunkHeights.removeAll(keepingCapacity: true)
        measuredWidth = nil

        var remaining = text
        while let split = splitIndexIfAvailable(
            in: remaining
        ) {
            appendChunk(String(remaining[..<split]))
            remaining = String(remaining[split...])
        }

        if !remaining.isEmpty || text.isEmpty {
            appendChunk(remaining)
        }
    }

    private func splitIndexIfAvailable(
        in text: String
    ) -> String.Index? {
        guard text.count > targetChunkCharacters else {
            return nil
        }

        let target = text.index(
            text.startIndex,
            offsetBy: targetChunkCharacters,
            limitedBy: text.endIndex
        ) ?? text.endIndex
        let minimum = text.index(
            text.startIndex,
            offsetBy: minimumChunkCharacters,
            limitedBy: target
        ) ?? text.startIndex

        if minimum < target,
           let newline = text[minimum..<target]
            .lastIndex(of: "\n") {
            return text.index(after: newline)
        }

        let lookahead = text.index(
            text.startIndex,
            offsetBy: chunkLookaheadCharacters,
            limitedBy: text.endIndex
        ) ?? text.endIndex

        if target < lookahead,
           let newline = text[target..<lookahead]
            .firstIndex(of: "\n") {
            return text.index(after: newline)
        }

        // Keep a long unbroken line intact rather than introducing a visual
        // line break that does not exist in Pi's output. Natural-language and
        // code responses normally reach a real newline within the lookahead.
        return nil
    }

    private func appendChunk(_ text: String) {
        let view = makeChunkView()
        addSubview(view)
        chunkTexts.append(text)
        chunkViews.append(view)
        chunkHeights.append(nil)
        setChunk(text, at: chunkTexts.count - 1)
    }

    private func setChunk(
        _ text: String,
        at index: Int
    ) {
        guard chunkTexts.indices.contains(index),
              chunkViews.indices.contains(index)
        else {
            return
        }

        guard chunkTexts[index] != text
            || chunkViews[index].text != text
        else {
            return
        }

        chunkTexts[index] = text
        let view = chunkViews[index]
        view.attributedText = NSAttributedString(
            string: text,
            attributes: textAttributes(for: view)
        )
        chunkHeights[index] = nil
    }

    private func makeChunkView() -> UITextView {
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

    private func boundaryStillMatches(
        in newText: NSString
    ) -> Bool {
        guard renderedUTF16Length > 0 else {
            return true
        }
        guard newText.length >= renderedUTF16Length else {
            return false
        }

        let sampleLength = min(
            boundarySampleUTF16Length,
            renderedUTF16Length
        )
        guard sampleLength > 0 else {
            return true
        }

        let range = NSRange(
            location: renderedUTF16Length - sampleLength,
            length: sampleLength
        )
        return newText.substring(with: range)
            == renderedBoundarySample
    }

    private func boundarySample(
        from text: NSString
    ) -> String {
        let sampleLength = min(
            boundarySampleUTF16Length,
            text.length
        )
        guard sampleLength > 0 else {
            return ""
        }

        return text.substring(
            from: text.length - sampleLength
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
