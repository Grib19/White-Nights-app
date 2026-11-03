import { User } from "../api";
import { SongsSection } from "./InfoPage";

// Вкладка «Музыка»: плеер песен отряда; добавлять и удалять песни может комсостав
export function MusicPage({ viewer }: { viewer: User }) {
  const committee = ["master", "commissar", "commander"].includes(viewer.role);
  return (
    <section>
      <h2>Музыка</h2>
      <SongsSection committee={committee} />
    </section>
  );
}
