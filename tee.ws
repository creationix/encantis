-- poor man's tee
-- Outputs to stderr and stdout whatever comes in stdin

import "wasi_unstable" (
  "fd_read"   func wasi_fd_read   (Fd IoVec OutSize) -> Result
  "fd_write"  func wasi_fd_write  (Fd IoVec OutSize) -> Result
  "proc_exit" func wasi_proc_exit (ExitCode)
)

type Fd: i32
type Size: u32
type IoVec: <<u8>>
type OutSize: *Size
type Result: i32
type ExitCode: i32

define stdin = 0 as Fd
define stdout = 1 as Fd

export "memory"
memory 1

global ioVec: *<u8> = 0
global ioBuffer: <u8> = (8, 1024)

export "_start"
func main () -> i32

  local res: Result

  loop-start
    block
      *ioVec = ioBuffer

      -- Read up to ioBuffer.len bytes from stdin.
      res = wasi_fd_read(stdin, IoVec(ioVec, 1), ioVec.len)

      -- Break out of the loop if fd_read returned an error, or 0 bytes were read.
      br-if res != 0 or ioVec.len == 0

      -- Write the bytes read from stdin to stdout.
      res = wasi_fd_write(stdout, IoVec(ioVec, 1), ioVec.len)
      br-if res != 0

      -- Write the bytes read from stdin to stderr.
      res = wasi_fd_write(stderr, IoVec(ioVec, 1), ioVec.len)
      br-if res != 0

      br-start
    end
  end

  wasi_proc_exit(res)

end