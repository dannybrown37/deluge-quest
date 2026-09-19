export const DEMO_SONG = {
  name: "Brahms Cello Sonata",
  xmlPath: "/demo/Brahms Cello Sonata.XML",
  songPagePath: "/songs/brahms-cello-sonata-no-1-mvt-1-exposition",
  fileName: "Brahms Cello Sonata.XML",
};

export async function fetchDemoXml(): Promise<string> {
  const res = await fetch(DEMO_SONG.xmlPath);
  if (!res.ok) throw new Error(`Failed to load demo song: ${res.status}`);
  return res.text();
}
