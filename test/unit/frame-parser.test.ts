import { expect } from "chai";
import { FrameParser, findJsonObjectEnd } from "../../src/lib/frame-parser";

describe("findJsonObjectEnd", () => {
  const buf = (s: string): Buffer => Buffer.from(s, "ascii");

  it("finds the matching closing brace of a flat object", () => {
    const b = buf('{"a":1}');
    expect(findJsonObjectEnd(b, 0)).to.equal(b.length - 1);
  });

  it("finds the matching brace of a nested object", () => {
    const b = buf('{"a":{"b":{"c":3}}}');
    expect(findJsonObjectEnd(b, 0)).to.equal(b.length - 1);
  });

  it("returns -1 for an incomplete object", () => {
    expect(findJsonObjectEnd(buf('{"a":1'), 0)).to.equal(-1);
    expect(findJsonObjectEnd(buf('{"a":{"b":'), 0)).to.equal(-1);
  });

  it("ignores braces inside strings", () => {
    const b = buf('{"label":"hi {nested} bye","x":1}');
    expect(findJsonObjectEnd(b, 0)).to.equal(b.length - 1);
  });

  it("respects escaped quotes inside strings", () => {
    const b = buf('{"note":"he said \\"hi\\"","x":1}');
    expect(findJsonObjectEnd(b, 0)).to.equal(b.length - 1);
  });

  it("respects escaped backslashes", () => {
    const b = buf('{"path":"C:\\\\Users\\\\test","x":1}');
    expect(findJsonObjectEnd(b, 0)).to.equal(b.length - 1);
  });
});

describe("FrameParser", () => {
  let parser: FrameParser;

  beforeEach(() => {
    parser = new FrameParser();
  });

  interface Frame {
    code: number;
    data: Record<string, unknown>;
  }

  it("returns no frames when buffer is empty", () => {
    expect(parser.drain<Frame>()).to.deep.equal([]);
  });

  it("parses a single complete frame", () => {
    parser.feed(Buffer.from('{"code":24658,"data":{"t211":67}}', "ascii"));
    const frames = parser.drain<Frame>();
    expect(frames).to.have.length(1);
    expect(frames[0].code).to.equal(24658);
    expect(frames[0].data.t211).to.equal(67);
  });

  it("parses two concatenated frames in one feed", () => {
    const wire =
      '{"code":24658,"data":{"t211":67}}{"code":24663,"data":{"t590":0}}';
    parser.feed(Buffer.from(wire, "ascii"));
    const frames = parser.drain<Frame>();
    expect(frames).to.have.length(2);
    expect(frames[0].code).to.equal(24658);
    expect(frames[1].code).to.equal(24663);
  });

  it("keeps incomplete trailing bytes for the next feed", () => {
    const full = '{"code":24658,"data":{"t211":67}}';
    const split = Math.floor(full.length / 2);

    parser.feed(Buffer.from(full.slice(0, split), "ascii"));
    expect(parser.drain<Frame>()).to.have.length(0);
    expect(parser.pendingBytes).to.be.greaterThan(0);

    parser.feed(Buffer.from(full.slice(split), "ascii"));
    const frames = parser.drain<Frame>();
    expect(frames).to.have.length(1);
    expect(frames[0].data.t211).to.equal(67);
    expect(parser.pendingBytes).to.equal(0);
  });

  it("skips garbage between frames (CRLF, whitespace)", () => {
    parser.feed(
      Buffer.from(
        '\r\n  {"code":1,"data":{}}\r\n{"code":2,"data":{}}\n',
        "ascii",
      ),
    );
    const frames = parser.drain<Frame>();
    expect(frames).to.have.length(2);
  });

  it("handles braces and quotes embedded in string values", () => {
    const wire =
      '{"code":24658,"data":{"label":"a {b} c","note":"\\"x\\"","t211":42}}';
    parser.feed(Buffer.from(wire, "ascii"));
    const frames = parser.drain<Frame>();
    expect(frames).to.have.length(1);
    expect(frames[0].data.t211).to.equal(42);
  });

  it("reports malformed frames via callback and continues parsing", () => {
    const errors: Array<{ raw: string; msg: string }> = [];
    const wire =
      '{"code":24658,"data":{"bad":}}{"code":24663,"data":{"t590":0}}';
    parser.feed(Buffer.from(wire, "ascii"));
    const frames = parser.drain<Frame>((raw, err) =>
      errors.push({ raw, msg: err.message }),
    );
    expect(errors).to.have.length(1);
    expect(frames).to.have.length(1);
    expect(frames[0].code).to.equal(24663);
  });

  it("reset() drops pending bytes", () => {
    parser.feed(Buffer.from('{"a":1', "ascii"));
    expect(parser.pendingBytes).to.be.greaterThan(0);
    parser.reset();
    expect(parser.pendingBytes).to.equal(0);
  });
});
