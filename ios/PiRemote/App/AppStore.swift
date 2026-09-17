import Foundation
import Observation

@Observable
@MainActor
final class AppStore {
    enum ConnectionState: Equatable {
        case unpaired
        case connecting
        case connected(hostName: String)
        case disconnected
    }

    var connectionState: ConnectionState = .unpaired
    var sessions: [RemoteSession] = []
    var selectedSessionID: String?
}
