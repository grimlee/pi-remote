import Foundation
import PiRemoteCore

#if canImport(PiRemoteTailcat)
import PiRemoteTailcat
#endif

struct TailcatDiagnostics: Codable, Equatable, Sendable {
    struct Probe: Codable, Equatable, Sendable {
        let ok: Bool
        let path: String?
        let latencyMs: Double?
        let derpRegion: String?
        let error: String?
    }

    let version: Int
    let localPort: Int
    let remotePort: Int
    let acceptedConnections: Int64
    let activeConnections: Int64
    let dialSuccesses: Int64
    let dialFailures: Int64
    let bytesToHost: Int64
    let bytesToPhone: Int64
    let lastError: String?
    let probe: Probe?
}

actor TailcatTransport {
    enum TransportError: LocalizedError {
        case nativeLibraryUnavailable
        case invalidConfiguration
        case startFailed(String)
        case invalidLocalPort
        case diagnosticsUnavailable(String)

        var errorDescription: String? {
            switch self {
            case .nativeLibraryUnavailable:
                return "The experimental Tailcat iOS library is not available in this build."
            case .invalidConfiguration:
                return "The Tailcat pairing transport is invalid."
            case let .startFailed(message):
                return "Tailcat could not start: \(message)"
            case .invalidLocalPort:
                return "Tailcat returned an invalid local bridge port."
            case let .diagnosticsUnavailable(message):
                return "Tailcat diagnostics are unavailable: \(message)"
            }
        }
    }

    private struct ActiveConfiguration: Equatable {
        let address: String
        let remotePort: Int
    }

    private var handle: Int64?
    private var activeConfiguration: ActiveConfiguration?
    private var localPort: Int?

    func endpoint(
        for transport: PairingTransport
    ) throws -> URL {
        guard transport.kind == .tailcat,
              let address = transport.address,
              address.hasPrefix("tc"),
              let remotePort = transport.remotePort,
              (1...65_535).contains(remotePort)
        else {
            throw TransportError.invalidConfiguration
        }

        let requested = ActiveConfiguration(
            address: address,
            remotePort: remotePort
        )

        if requested == activeConfiguration,
           let localPort,
           let url = Self.makeRelayURL(localPort: localPort) {
            return url
        }

        stop()

        #if canImport(PiRemoteTailcat)
        let result = address.withCString { pointer -> Int64 in
            Int64(
                piremote_tailcat_start(
                    UnsafeMutablePointer(mutating: pointer),
                    Int32(remotePort)
                )
            )
        }

        guard result > 0 else {
            throw TransportError.startFailed(Self.nativeError())
        }

        let port = Int(piremote_tailcat_local_port(result))
        guard (1...65_535).contains(port),
              let url = Self.makeRelayURL(localPort: port)
        else {
            piremote_tailcat_stop(result)
            throw TransportError.invalidLocalPort
        }

        handle = result
        activeConfiguration = requested
        localPort = port
        return url
        #else
        throw TransportError.nativeLibraryUnavailable
        #endif
    }

    func diagnostics(
        probe: Bool = true
    ) throws -> TailcatDiagnostics {
        #if canImport(PiRemoteTailcat)
        guard let handle else {
            throw TransportError.diagnosticsUnavailable(
                "the native bridge is not running"
            )
        }

        guard let pointer = piremote_tailcat_diagnostics(
            handle,
            probe ? 1 : 0
        ) else {
            throw TransportError.diagnosticsUnavailable(
                Self.nativeError()
            )
        }
        defer {
            piremote_tailcat_free_string(pointer)
        }

        guard let data = String(cString: pointer).data(using: .utf8) else {
            throw TransportError.diagnosticsUnavailable(
                "native diagnostics are not valid UTF-8"
            )
        }

        do {
            return try JSONDecoder().decode(
                TailcatDiagnostics.self,
                from: data
            )
        } catch {
            throw TransportError.diagnosticsUnavailable(
                "could not decode native diagnostics"
            )
        }
        #else
        throw TransportError.nativeLibraryUnavailable
        #endif
    }

    func stop() {
        #if canImport(PiRemoteTailcat)
        if let handle {
            piremote_tailcat_stop(handle)
        }
        #endif

        handle = nil
        activeConfiguration = nil
        localPort = nil
    }

    private static func makeRelayURL(localPort: Int) -> URL? {
        URL(string: "ws://127.0.0.1:\(localPort)/v0/client")
    }

    #if canImport(PiRemoteTailcat)
    private static func nativeError() -> String {
        guard let pointer = piremote_tailcat_last_error() else {
            return "unknown native error"
        }
        defer {
            piremote_tailcat_free_string(pointer)
        }
        return String(cString: pointer)
    }
    #endif
}
