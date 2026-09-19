package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/tailscale/tailcat"
)

type tunnel struct {
	client     *tailcat.Client
	listener   net.Listener
	cancel     context.CancelFunc
	remotePort uint16
	localPort  int

	acceptedConnections atomic.Int64
	activeConnections   atomic.Int64
	dialSuccesses       atomic.Int64
	dialFailures        atomic.Int64
	bytesToHost         atomic.Int64
	bytesToPhone        atomic.Int64

	lastErrorMu sync.Mutex
	lastError   string
	eventsMu    sync.Mutex
	events      []diagnosticsEvent
}

type countingWriter struct {
	writer  io.Writer
	counter *atomic.Int64
}

func (w countingWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	if n > 0 {
		w.counter.Add(int64(n))
	}
	return n, err
}

type diagnosticsEvent struct {
	At     string `json:"at"`
	Event  string `json:"event"`
	Detail string `json:"detail,omitempty"`
}

type diagnosticsProbe struct {
	OK         bool    `json:"ok"`
	Path       string  `json:"path,omitempty"`
	LatencyMS  float64 `json:"latencyMs,omitempty"`
	DERPRegion string  `json:"derpRegion,omitempty"`
	Error      string  `json:"error,omitempty"`
}

type diagnosticsSnapshot struct {
	Version             int               `json:"version"`
	LocalPort           int               `json:"localPort"`
	RemotePort          int               `json:"remotePort"`
	AcceptedConnections int64             `json:"acceptedConnections"`
	ActiveConnections   int64             `json:"activeConnections"`
	DialSuccesses       int64             `json:"dialSuccesses"`
	DialFailures        int64             `json:"dialFailures"`
	BytesToHost         int64             `json:"bytesToHost"`
	BytesToPhone        int64             `json:"bytesToPhone"`
	LastError           string            `json:"lastError,omitempty"`
	Probe               *diagnosticsProbe `json:"probe,omitempty"`
	Events              []diagnosticsEvent `json:"events,omitempty"`
}

var tailcatSecretPattern = regexp.MustCompile(`tc[A-Za-z0-9_-]{20,}`)

var (
	tunnelsMu    sync.Mutex
	tunnels      = map[int64]*tunnel{}
	nextHandle   atomic.Int64
	lastErrorMu  sync.Mutex
	lastErrorMsg string
)

func setLastError(err error) {
	lastErrorMu.Lock()
	defer lastErrorMu.Unlock()
	if err == nil {
		lastErrorMsg = ""
		return
	}
	lastErrorMsg = err.Error()
}

func (t *tunnel) setError(err error) {
	t.lastErrorMu.Lock()
	defer t.lastErrorMu.Unlock()
	if err == nil {
		t.lastError = ""
		return
	}
	t.lastError = err.Error()
}

func (t *tunnel) errorString() string {
	t.lastErrorMu.Lock()
	defer t.lastErrorMu.Unlock()
	return t.lastError
}

func redactDiagnosticDetail(value string) string {
	return tailcatSecretPattern.ReplaceAllString(value, "tc[REDACTED]")
}

func (t *tunnel) addEvent(event, detail string) {
	t.eventsMu.Lock()
	defer t.eventsMu.Unlock()
	t.events = append(t.events, diagnosticsEvent{
		At:     time.Now().UTC().Format(time.RFC3339Nano),
		Event:  event,
		Detail: redactDiagnosticDetail(detail),
	})
	if len(t.events) > 64 {
		t.events = append([]diagnosticsEvent(nil), t.events[len(t.events)-64:]...)
	}
}

func (t *tunnel) eventSnapshot() []diagnosticsEvent {
	t.eventsMu.Lock()
	defer t.eventsMu.Unlock()
	return append([]diagnosticsEvent(nil), t.events...)
}

func proxyConnection(ctx context.Context, t *tunnel, local net.Conn) {
	defer local.Close()

	t.addEvent("dial.start", fmt.Sprintf("remotePort=%d", t.remotePort))
	remote, err := t.client.DialTCPPort(ctx, t.remotePort)
	if err != nil {
		t.dialFailures.Add(1)
		wrapped := fmt.Errorf("tailcat dial failed: %w", err)
		t.setError(wrapped)
		setLastError(wrapped)
		t.addEvent("dial.fail", wrapped.Error())
		return
	}
	t.dialSuccesses.Add(1)
	t.addEvent("dial.ok", fmt.Sprintf("remotePort=%d", t.remotePort))
	t.activeConnections.Add(1)
	t.setError(nil)
	defer t.activeConnections.Add(-1)
	defer remote.Close()

	errc := make(chan error, 2)
	go func() {
		_, err := io.Copy(
			countingWriter{writer: remote, counter: &t.bytesToHost},
			local,
		)
		errc <- err
	}()
	go func() {
		_, err := io.Copy(
			countingWriter{writer: local, counter: &t.bytesToPhone},
			remote,
		)
		errc <- err
	}()

	select {
	case <-ctx.Done():
		t.addEvent("connection.closed", "context cancelled")
	case err := <-errc:
		if err != nil {
			wrapped := fmt.Errorf("tailcat proxy failed: %w", err)
			t.setError(wrapped)
			t.addEvent("connection.closed", wrapped.Error())
		} else {
			t.addEvent("connection.closed", "stream closed")
		}
	}
}

func acceptLoop(ctx context.Context, t *tunnel) {
	for {
		local, err := t.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				wrapped := fmt.Errorf("local Tailcat bridge accept failed: %w", err)
				t.setError(wrapped)
				setLastError(wrapped)
				return
			}
		}
		t.acceptedConnections.Add(1)
		t.addEvent("local.accept", "loopback WebSocket connection accepted")
		go proxyConnection(ctx, t, local)
	}
}

func probeTunnel(t *tunnel) *diagnosticsProbe {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	res, err := t.client.DiscoPing(ctx)
	if err != nil {
		t.addEvent("probe.fail", err.Error())
		return &diagnosticsProbe{
			OK:    false,
			Error: err.Error(),
		}
	}

	probe := &diagnosticsProbe{
		OK:        true,
		LatencyMS: res.LatencySeconds * 1000,
	}
	if res.Endpoint != "" {
		probe.Path = "direct"
		t.addEvent("probe.ok", fmt.Sprintf("path=direct latencyMs=%.1f", probe.LatencyMS))
		return probe
	}

	probe.Path = "derp"
	probe.DERPRegion = res.DERPRegionCode
	if probe.DERPRegion == "" {
		probe.DERPRegion = res.DERPRegionID.String()
	}
	t.addEvent(
		"probe.ok",
		fmt.Sprintf("path=derp region=%s latencyMs=%.1f", probe.DERPRegion, probe.LatencyMS),
	)
	return probe
}

func snapshot(t *tunnel, withProbe bool) diagnosticsSnapshot {
	value := diagnosticsSnapshot{
		Version:             1,
		LocalPort:           t.localPort,
		RemotePort:          int(t.remotePort),
		AcceptedConnections: t.acceptedConnections.Load(),
		ActiveConnections:   t.activeConnections.Load(),
		DialSuccesses:       t.dialSuccesses.Load(),
		DialFailures:        t.dialFailures.Load(),
		BytesToHost:         t.bytesToHost.Load(),
		BytesToPhone:        t.bytesToPhone.Load(),
		LastError:           t.errorString(),
		Events:              t.eventSnapshot(),
	}
	if withProbe {
		value.Probe = probeTunnel(t)
	}
	return value
}

//export piremote_tailcat_start
func piremote_tailcat_start(address *C.char, remotePort C.int) C.longlong {
	setLastError(nil)

	if address == nil {
		setLastError(fmt.Errorf("Tailcat address is required"))
		return -1
	}

	port := int(remotePort)
	if port < 1 || port > 65535 {
		setLastError(fmt.Errorf("remote port must be between 1 and 65535"))
		return -1
	}

	addr := C.GoString(address)
	if len(addr) < 20 || addr[:2] != "tc" {
		setLastError(fmt.Errorf("invalid Tailcat address"))
		return -1
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		setLastError(fmt.Errorf("could not open local Tailcat bridge: %w", err))
		return -1
	}

	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		listener.Close()
		setLastError(fmt.Errorf("unexpected local listener address"))
		return -1
	}

	ctx, cancel := context.WithCancel(context.Background())
	client := tailcat.NewClient(tailcat.Addr(addr))
	t := &tunnel{
		client:     client,
		listener:   listener,
		cancel:     cancel,
		remotePort: uint16(port),
		localPort:  tcpAddr.Port,
	}
	client.Logf = func(format string, args ...any) {
		t.addEvent("tailcat.log", fmt.Sprintf(format, args...))
	}
	t.addEvent(
		"bridge.start",
		fmt.Sprintf("localPort=%d remotePort=%d", tcpAddr.Port, port),
	)

	handle := nextHandle.Add(1)
	if handle <= 0 {
		handle = nextHandle.Add(1)
	}

	tunnelsMu.Lock()
	tunnels[handle] = t
	tunnelsMu.Unlock()

	go acceptLoop(ctx, t)
	return C.longlong(handle)
}

//export piremote_tailcat_local_port
func piremote_tailcat_local_port(handle C.longlong) C.int {
	tunnelsMu.Lock()
	t := tunnels[int64(handle)]
	tunnelsMu.Unlock()
	if t == nil {
		setLastError(fmt.Errorf("unknown Tailcat tunnel handle"))
		return -1
	}
	return C.int(t.localPort)
}

//export piremote_tailcat_diagnostics
func piremote_tailcat_diagnostics(handle C.longlong, withProbe C.int) *C.char {
	tunnelsMu.Lock()
	t := tunnels[int64(handle)]
	tunnelsMu.Unlock()
	if t == nil {
		setLastError(fmt.Errorf("unknown Tailcat tunnel handle"))
		return nil
	}

	data, err := json.Marshal(snapshot(t, withProbe != 0))
	if err != nil {
		setLastError(fmt.Errorf("could not encode Tailcat diagnostics: %w", err))
		return nil
	}
	return C.CString(string(data))
}

//export piremote_tailcat_stop
func piremote_tailcat_stop(handle C.longlong) {
	tunnelsMu.Lock()
	t := tunnels[int64(handle)]
	delete(tunnels, int64(handle))
	tunnelsMu.Unlock()
	if t == nil {
		return
	}

	t.cancel()
	_ = t.listener.Close()
	_ = t.client.Close()
}

//export piremote_tailcat_last_error
func piremote_tailcat_last_error() *C.char {
	lastErrorMu.Lock()
	defer lastErrorMu.Unlock()
	if lastErrorMsg == "" {
		return nil
	}
	return C.CString(lastErrorMsg)
}

//export piremote_tailcat_free_string
func piremote_tailcat_free_string(value *C.char) {
	if value != nil {
		C.free(unsafe.Pointer(value))
	}
}

func main() {}
