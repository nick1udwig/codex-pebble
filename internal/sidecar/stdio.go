package sidecar

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

var (
	processStdin  = os.Stdin
	processStdout = os.Stdout
)

type StdioUpstream struct {
	reader *bufio.Reader
	writer io.Writer
	closer io.Closer
	mu     sync.Mutex
}

func NewProcessStdioUpstream() *StdioUpstream {
	return NewStdioUpstream(processStdin, processStdout, nil)
}

func NewStdioUpstream(input io.Reader, output io.Writer, closer io.Closer) *StdioUpstream {
	return &StdioUpstream{
		reader: bufio.NewReader(input),
		writer: output,
		closer: closer,
	}
}

func (s *StdioUpstream) Send(payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, err := s.writer.Write(bytes.TrimRight(payload, "\r\n")); err != nil {
		return err
	}
	_, err := s.writer.Write([]byte{'\n'})
	return err
}

func (s *StdioUpstream) Recv() ([]byte, error) {
	line, err := s.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	return bytes.TrimRight(line, "\r\n"), nil
}

func (s *StdioUpstream) Close() error {
	if s.closer == nil {
		return nil
	}
	return s.closer.Close()
}

func StdioTransportAvailable(input, output *os.File) error {
	if input == nil || output == nil {
		return errors.New("stdin/stdout are not available")
	}
	if err := streamLooksConnected("stdin", input); err != nil {
		return err
	}
	if err := streamLooksConnected("stdout", output); err != nil {
		return err
	}
	return nil
}

func streamLooksConnected(name string, file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("%s stat failed: %w", name, err)
	}
	mode := info.Mode()
	if mode&os.ModeCharDevice != 0 {
		return fmt.Errorf("%s is a terminal, not an app-server stdio stream", name)
	}
	if mode&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return fmt.Errorf("%s is not a pipe or socket", name)
	}
	return nil
}
