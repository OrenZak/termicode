#!/usr/bin/env python3
"""
Termicode PTY bridge.
Spawns a CLI agent in a real pseudo-terminal and bridges raw I/O through stdin/stdout.
Usage: python3 pty_bridge.py <command_path> <cols> <rows>
"""
import sys, os, pty, select, signal, struct, fcntl, termios

def set_winsize(fd, cols, rows):
    try:
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass

def main():
    command_path = sys.argv[1] if len(sys.argv) > 1 else 'claude'
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    extra_args = sys.argv[4:] if len(sys.argv) > 4 else []

    master, slave = pty.openpty()
    set_winsize(master, cols, rows)

    pid = os.fork()
    if pid == 0:
        # Child: become session leader, attach slave PTY, exec the agent CLI
        os.setsid()
        try:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 1)
        except Exception:
            pass
        for fd in range(3):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        os.close(master)
        env = dict(os.environ)
        env['TERM'] = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        os.execvpe(command_path, [command_path] + extra_args, env)
        os._exit(1)

    # Parent: bridge stdin → PTY master and PTY master → stdout
    os.close(slave)

    stdin_fd  = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    # Input buffer for resize escape: \x1b[8;<rows>;<cols>t
    input_buf = b''

    try:
        while True:
            r, _, _ = select.select([master, stdin_fd], [], [], 0.5)

            if master in r:
                try:
                    data = os.read(master, 4096)
                    if not data:
                        break
                    os.write(stdout_fd, data)
                except OSError:
                    break

            if stdin_fd in r:
                try:
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        break
                    # Parse resize escape sequences out of the stream
                    input_buf += data
                    input_buf = _process_input(master, input_buf)
                except OSError:
                    break

            try:
                ret = os.waitpid(pid, os.WNOHANG)
                if ret[0] != 0:
                    break
            except ChildProcessError:
                break
    finally:
        try:
            os.close(master)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass


def _process_input(master_fd, buf):
    """
    Forward data to the PTY, intercepting resize commands.
    Resize command format (sent by the extension): \x1b[8;<rows>;<cols>t
    """
    import re
    # Try to consume resize sequences without forwarding them to the agent CLI
    resize_re = re.compile(rb'\x1b\[8;(\d+);(\d+)t')
    out = b''
    while buf:
        m = resize_re.search(buf)
        if m is None:
            out += buf
            buf = b''
        else:
            out += buf[:m.start()]
            rows = int(m.group(1))
            cols = int(m.group(2))
            set_winsize(master_fd, cols, rows)
            buf = buf[m.end():]
    if out:
        try:
            os.write(master_fd, out)
        except OSError:
            pass
    return b''


if __name__ == '__main__':
    main()
