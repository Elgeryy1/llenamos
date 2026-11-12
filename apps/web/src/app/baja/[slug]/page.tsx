import { BajaView } from "./BajaView"

export const metadata = { title: "Baja de novedades", robots: { index: false, follow: false } }
export const instant = false

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ t?: string | string[] }>
}) {
  const { slug } = await params
  const { t } = await searchParams
  return <BajaView slug={slug} token={typeof t === "string" ? t : ""} />
}
