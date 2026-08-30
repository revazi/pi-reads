export interface BenchmarkTextFixture {
  name: 'short' | 'medium' | 'long';
  label: string;
  markdown: string;
}

export interface BenchmarkFixtureSet {
  short: BenchmarkTextFixture;
  medium: BenchmarkTextFixture;
  long: BenchmarkTextFixture;
  multiSource: BenchmarkTextFixture[];
}

function paragraphs(prefix: string, count: number, sentences: number): string {
  return Array.from({ length: count }, (_, paragraphIndex) => {
    const body = Array.from({ length: sentences }, (_, sentenceIndex) =>
      `${prefix} paragraph ${paragraphIndex + 1}, observation ${sentenceIndex + 1}, describes deterministic reading-library behavior without external content.`,
    ).join(' ');
    return `## ${prefix} section ${paragraphIndex + 1}\n\n${body}`;
  }).join('\n\n');
}

function fixture(name: BenchmarkTextFixture['name'], paragraphCount: number, sentences: number): BenchmarkTextFixture {
  const label = `Benchmark ${name} fixture`;
  return {
    name,
    label,
    markdown: `# ${label}\n\n${paragraphs(label, paragraphCount, sentences)}\n`,
  };
}

export function createBenchmarkFixtures(): BenchmarkFixtureSet {
  const short = fixture('short', 3, 2);
  const medium = fixture('medium', 24, 4);
  const long = fixture('long', 160, 5);
  const multiSource = Array.from({ length: 5 }, (_, index) => {
    const label = `Benchmark synthesis source ${index + 1}`;
    return {
      name: 'medium' as const,
      label,
      markdown: `# ${label}\n\n${paragraphs(label, 20, 4)}\n`,
    };
  });
  return { short, medium, long, multiSource };
}
