package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/tailscale/tailcat"
)

type tunnel struct {
	client     *tailcat.Client
	listener   net.Listener
	cancel     context.CancelFunc
	remotePort uint16
	localPort  int
}

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

func proxyConnection(ctx context.Context, t *tunnel, local net.Conn) {
	defer local.Close()

	remote, err := t.client.DialTCPPort(ctx, t.remotePort)
	if err != nil {
		setLastError(fmt.Errorf("tailcat dial failed: %w", err))
		return
	}
	defer remote.Close()

	errc := make(chan error, 2)
	go func() {
		_, err := io.Copy(remote, local)
		errc <- err
	}()
	go func() {
		_, err := io.Copy(local, remote)
		errc <- err
	}()

	select {
	case <-ctx.Done():
	case <-errc:
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
				setLastError(fmt.Errorf("local Tailcat bridge accept failed: %w", err))
				return
			}
		}
		go proxyConnection(ctx, t, local)
	}
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
