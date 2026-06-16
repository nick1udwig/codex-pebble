package sidecar

import (
	"bytes"
	"io"
	"os"
	"testing"
)

func TestStdioUpstreamForwardsJSONL(t *testing.T) {
	input := bytes.NewBufferString(`{"id":1,"result":"ok"}` + "\n")
	var output bytes.Buffer

	upstream := NewStdioUpstream(input, &output, io.NopCloser(bytes.NewReader(nil)))
	if err := upstream.Send([]byte(`{"id":2,"method":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	got, err := upstream.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"id":1,"result":"ok"}` {
		t.Fatalf("Recv() = %q", got)
	}
	if output.String() != `{"id":2,"method":"ping"}`+"\n" {
		t.Fatalf("Send wrote %q", output.String())
	}
}

func TestStdioTransportAvailableRequiresPipes(t *testing.T) {
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdinReader.Close()
	defer stdinWriter.Close()
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdoutReader.Close()
	defer stdoutWriter.Close()

	if err := StdioTransportAvailable(stdinReader, stdoutWriter); err != nil {
		t.Fatal(err)
	}
}

func TestStdioTransportAvailableRejectsRegularFiles(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "stdio")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	if err := StdioTransportAvailable(file, file); err == nil {
		t.Fatal("expected regular file stdio to be rejected")
	}
}
