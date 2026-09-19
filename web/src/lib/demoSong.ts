interface DemoSong {
  name: string;
  xmlPath: string;
  songPagePath: string;
  fileName: string;
}

export const DEMO_SONG: DemoSong = {
  name: "Brahms Cello Sonata",
  xmlPath: "/demo/Brahms Cello Sonata.XML",
  songPagePath: "/songs/brahms-cello-sonata-no-1-mvt-1-exposition",
  fileName: "Brahms Cello Sonata.XML",
};

export const DEMO_SONGS: DemoSong[] = [
  DEMO_SONG,
  {
    name: "Clean This House",
    xmlPath: "/demo/Clean This House.XML",
    songPagePath: "/songs/clean-this-house",
    fileName: "Clean This House.XML",
  },
  {
    name: "Square Spelunking",
    xmlPath: "/demo/Square Spelunking.XML",
    songPagePath: "/songs/square-spelunking",
    fileName: "Square Spelunking.XML",
  },
  {
    name: "48-bar Piano and Arp Loop",
    xmlPath: "/demo/48-bar Piano and Arp Loop.XML",
    songPagePath: "/songs",
    fileName: "48-bar Piano and Arp Loop.XML",
  },
  {
    name: "Eoi",
    xmlPath: "/demo/Eoi.XML",
    songPagePath: "/songs",
    fileName: "Eoi.XML",
  },
  {
    name: "Stamina Management",
    xmlPath: "/demo/Stamina Management.XML",
    songPagePath: "/songs/stamina-management",
    fileName: "Stamina Management.XML",
  },
  {
    name: "Cruisin'",
    xmlPath: "/demo/Cruisin.XML",
    songPagePath: "/songs/cruisin-2020-arcade",
    fileName: "Cruisin.XML",
  },
];

export async function fetchDemoXml(): Promise<string> {
  const res = await fetch(DEMO_SONG.xmlPath);
  if (!res.ok) throw new Error(`Failed to load demo song: ${res.status}`);
  return res.text();
}

export async function fetchAllDemoXmls(): Promise<
  { name: string; content: string }[]
> {
  return Promise.all(
    DEMO_SONGS.map(async (song) => {
      const res = await fetch(song.xmlPath);
      if (!res.ok)
        throw new Error(`Failed to load ${song.name}: ${res.status}`);
      return { name: song.fileName, content: await res.text() };
    }),
  );
}
