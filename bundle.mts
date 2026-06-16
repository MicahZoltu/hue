/*
 * Build script for the bundle + service-worker demo.
 *
 * Scans hue-app/ for desktop app files and generates three priority-split
 * bundle JSON files in hue-app/bundles/:
 *
 *   - high-priority.json   HTML + CSS + the manifest map
 *   - medium-priority.json JavaScript
 *   - low-priority.json    Images and other assets
 *
 * The build script does NOT modify any source files.  It only creates
 * the bundles directory and writes the three JSON files into it.
 *
 * Run with:
 *   bun run build.mts
 */

import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = dirname(new URL(import.meta.url).pathname)
const appDir = join(root, 'hue-app')
const bundlesDir = join(appDir, 'bundles')

const mimeTypes: Record<string, string> = {
	'.html'         : 'text/html',
	'.js'           : 'application/javascript',
	'.css'          : 'text/css',
	'.svg'          : 'image/svg+xml',
	'.webmanifest'  : 'application/manifest+json',
	'.json'         : 'application/json',
	'.png'          : 'image/png',
	'.jpg'          : 'image/jpeg',
	'.jpeg'         : 'image/jpeg',
	'.gif'          : 'image/gif',
	'.webp'         : 'image/webp',
	'.woff2'        : 'font/woff2',
	'.woff'         : 'font/woff',
	'.ttf'          : 'font/ttf',
	'.otf'          : 'font/otf',
	'.eot'          : 'application/vnd.ms-fontobject',
	'.ico'          : 'image/x-icon',
	'.pdf'          : 'application/pdf',
	'.zip'          : 'application/zip',
}

const binaryExts = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
	'.woff', '.woff2', '.ttf', '.otf', '.eot',
	'.mp3', '.mp4', '.webm', '.ogg', '.wasm', '.zip', '.pdf',
])

function getExt(name: string): string {
	const i = name.lastIndexOf('.')
	return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64')
}

type Priority = 'high' | 'medium' | 'low'

const desktopFiles: Array<{ path: string, priority: Priority }> = [
	{ path: 'hue.html', priority: 'high' },
	{ path: 'style.css', priority: 'high' },
	{ path: 'app.js', priority: 'medium' },
	{ path: 'color.js', priority: 'medium' },
	{ path: 'core.js', priority: 'medium' },
	{ path: 'hue.js', priority: 'medium' },
	{ path: 'icon.svg', priority: 'low' },
]

async function main(): Promise<void> {
	await rm(bundlesDir, { recursive: true, force: true })
	await mkdir(bundlesDir, { recursive: true })

	const manifest: Record<string, Priority> = {}
	const high: Array<Record<string, string>> = []
	const medium: Array<Record<string, string>> = []
	const low: Array<Record<string, string>> = []

	for (const entry of desktopFiles) {
		const filePath = join(appDir, entry.path)
		const src = Bun.file(filePath)
		const ext = getExt(entry.path)
		const isBinary = binaryExts.has(ext)

		const fileRecord: Record<string, string> = {
			path: entry.path,
			type: mimeTypes[ext] || (isBinary ? 'application/octet-stream' : 'text/plain'),
			encoding: isBinary ? 'base64' : '',
			body: isBinary ? base64(await src.bytes()) : await src.text(),
		}

		manifest[entry.path] = entry.priority

		if (entry.priority === 'high') {
			high.push(fileRecord)
		} else if (entry.priority === 'medium') {
			medium.push(fileRecord)
		} else {
			low.push(fileRecord)
		}
	}

	await Bun.write(
		join(bundlesDir, 'high-priority.json'),
		JSON.stringify({ manifest, files: high }),
	)
	await Bun.write(
		join(bundlesDir, 'medium-priority.json'),
		JSON.stringify({ files: medium }),
	)
	await Bun.write(
		join(bundlesDir, 'low-priority.json'),
		JSON.stringify({ files: low }),
	)

	console.log(`Built bundles in ${bundlesDir}`)
	console.log(`  high:   ${high.length} files (${desktopFiles.filter(e => e.priority === 'high').map(e => e.path).join(', ')})`)
	console.log(`  medium: ${medium.length} files (${desktopFiles.filter(e => e.priority === 'medium').map(e => e.path).join(', ')})`)
	console.log(`  low:    ${low.length} files (${desktopFiles.filter(e => e.priority === 'low').map(e => e.path).join(', ')})`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})