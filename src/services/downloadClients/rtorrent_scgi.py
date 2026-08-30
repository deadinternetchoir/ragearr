#!/usr/bin/env python3
"""
Minimal SCGI client for talking to rTorrent's local XML-RPC socket.

rTorrent exposes its control interface over SCGI-wrapped XML-RPC on a local
Unix socket (network.scgi.open_local in rtorrent.rc) rather than a network
port. No third-party libraries needed - this implements the (simple) SCGI
framing by hand: netstring-encoded headers, then the XML-RPC body appended
directly.

Usage (from an SSH session on the box rTorrent runs on):
    python3 rtorrent_scgi.py <socket_path> <method_name> [param ...]

Params are passed as strings; this doesn't attempt XML-RPC type inference
beyond strings, which is sufficient for the calls this app needs (adding a
torrent by URL/data, listing torrents, checking status).
"""
import socket
import sys
import xmlrpc.client


def build_scgi_request(xmlrpc_body: bytes) -> bytes:
    headers = {
        "CONTENT_LENGTH": str(len(xmlrpc_body)),
        "SCGI": "1",
    }
    header_str = "".join(f"{k}\x00{v}\x00" for k, v in headers.items())
    header_bytes = header_str.encode("utf-8")
    return f"{len(header_bytes)}:".encode("utf-8") + header_bytes + b"," + xmlrpc_body


def scgi_call(socket_path: str, method: str, params: list):
    xmlrpc_body = xmlrpc.client.dumps(tuple(params), methodname=method).encode("utf-8")
    request = build_scgi_request(xmlrpc_body)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path)
    sock.sendall(request)
    sock.shutdown(socket.SHUT_WR)

    chunks = []
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
    sock.close()

    raw = b"".join(chunks)
    # Response is SCGI-style: headers, blank line, then the XML-RPC body.
    body = raw.split(b"\r\n\r\n", 1)[-1] if b"\r\n\r\n" in raw else raw
    result, _method_name = xmlrpc.client.loads(body.decode("utf-8"))
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: rtorrent_scgi.py <socket_path> <method_name> [param ...]", file=sys.stderr)
        sys.exit(2)
    socket_path = sys.argv[1]
    method = sys.argv[2]
    params = sys.argv[3:]
    try:
        result = scgi_call(socket_path, method, params)
        print(result)
    except xmlrpc.client.Fault as e:
        print(f"XML-RPC fault: {e.faultCode} {e.faultString}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
