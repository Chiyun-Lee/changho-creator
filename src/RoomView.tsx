import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import { depthOf, fmt, rectOf, type Design, type Placement } from './model'
import { loadScan, saveScan } from './scanStore'

interface Props {
  design: Design
  /** Set where the panel hangs, and optionally its size in mm. */
  onPlace: (placement: Placement, size?: { w: number; h: number }) => void
  /** The scan or its orientation changed, so any old placement is meaningless. */
  onScanReplaced: () => void
}

const MM = 0.001
/** Gap between the fitted wall plane and the back of the panel, in metres. */
const WALL_GAP = 0.008
const UP = new THREE.Vector3(0, 1, 0)
const ROT_KEY = 'changho-scan-rot'
const isSplatFile = (name: string) => /\.(ply|spz)$/i.test(name)

interface Stage {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  scan: THREE.Group
  splat: SplatMesh | null
  panel: THREE.Group
  /** Materials of the pulsing outline; userData.base is their peak opacity. */
  glow: THREE.MeshBasicMaterial[]
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || !mesh.material) return
    mesh.geometry.dispose()
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const map = (m as THREE.MeshBasicMaterial).map
      if (map) map.dispose()
      m.dispose()
    }
  })
}

function clearScan(s: Stage) {
  if (s.splat) s.splat.dispose()
  else disposeTree(s.scan)
  s.splat = null
  s.scan.clear()
}

/**
 * Fit a vertical plane through points hit on the scan. Returns null when the
 * points do not lie on one vertical plane (a floor, a ceiling or a corner).
 */
export function fitWall(points: THREE.Vector3[]) {
  const fit = (pts: THREE.Vector3[]) => {
    const c = new THREE.Vector3()
    for (const p of pts) c.add(p)
    c.divideScalar(pts.length)
    let sxx = 0
    let szz = 0
    let sxz = 0
    for (const p of pts) {
      const dx = p.x - c.x
      const dz = p.z - c.z
      sxx += dx * dx
      szz += dz * dz
      sxz += dx * dz
    }
    const t = 0.5 * Math.atan2(2 * sxz, sxx - szz) // direction the wall runs in
    const n = new THREE.Vector3(-Math.sin(t), 0, Math.cos(t))
    const spread = Math.sqrt(
      Math.max(0, (sxx + szz - Math.hypot(sxx - szz, 2 * sxz)) / 2 / pts.length),
    )
    return { c, n, spread }
  }
  let f = fit(points)
  // Drop stray points (furniture, floating splats) and fit again.
  const res = points.map((p) => Math.abs(p.clone().sub(f.c).dot(f.n)))
  const median = [...res].sort((a, b) => a - b)[res.length >> 1]
  const kept = points.filter((_, i) => res[i] <= Math.max(0.02, 2.5 * median))
  if (kept.length >= 6 && kept.length < points.length) f = fit(kept)
  return f.spread > 0.12 ? null : f
}

export default function RoomView({ design, onPlace, onScanReplaced }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const stage = useRef<Stage | null>(null)
  const [hasScan, setHasScan] = useState(false)
  const [rot, setRot] = useState(0)
  const [outlining, setOutlining] = useState(false)
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [msg, setMsg] = useState('')

  // Latest props/state for the long-lived native event handlers.
  const live = useRef({ design, onPlace, outlining })
  live.current = { design, onPlace, outlining }

  /** Turn the scan upright by `r` quarter turns and point the camera at it. */
  const orient = (r: number) => {
    const s = stage.current
    if (!s) return
    s.scan.rotation.x = (r * Math.PI) / 2
    s.scan.updateMatrixWorld(true)
    const bb = s.splat
      ? s.splat.getBoundingBox(true).applyMatrix4(s.scan.matrixWorld)
      : new THREE.Box3().setFromObject(s.scan)
    const centre = bb.getCenter(new THREE.Vector3())
    const size = bb.getSize(new THREE.Vector3())
    const d = Math.max(size.x, size.y, size.z)
    // Meshes are see-through from behind, so look in from outside.
    // Splats are not, so start inside the room.
    const k = s.splat ? 0.15 : 0.8
    s.controls.target.copy(centre)
    s.camera.position.copy(centre).add(new THREE.Vector3(d * k, d * k * 0.5, d * k))
    s.controls.update()
    setRot(r)
    try {
      localStorage.setItem(ROT_KEY, String(r))
    } catch {
      // not persisted
    }
    setMsg(
      `Scan is ${s.splat ? 'about ' : ''}${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m (width × height × depth)`,
    )
  }

  const showScan = async (blob: Blob, name: string, r: number) => {
    if (!stage.current) return false
    try {
      let content: THREE.Object3D
      let splat: SplatMesh | null = null
      if (isSplatFile(name)) {
        splat = new SplatMesh({ fileBytes: await blob.arrayBuffer(), fileName: name })
        await splat.initialized
        content = splat
      } else {
        const gltf = await new GLTFLoader().parseAsync(await blob.arrayBuffer(), '')
        // Show the mesh with its captured colours, unlit and single-sided so
        // you can look into the room from outside.
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const old = mesh.material as THREE.MeshStandardMaterial
          mesh.material = new THREE.MeshBasicMaterial({
            map: old.map ?? null,
            color: old.map ? 0xffffff : old.color,
            vertexColors: !!mesh.geometry.attributes.color,
            side: THREE.FrontSide,
          })
          old.dispose()
        })
        content = gltf.scene
      }
      const s = stage.current
      if (!s) return false
      clearScan(s)
      s.scan.add(content)
      s.splat = splat
      setHasScan(true)
      orient(r)
      return true
    } catch (err) {
      setMsg(`Could not read ${name}: ${(err as Error).message}`)
      return false
    }
  }

  // One-time scene setup.
  useEffect(() => {
    const host = hostRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    host.appendChild(renderer.domElement)
    const el = renderer.domElement
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x26231f)
    const spark = new SparkRenderer({ renderer })
    scene.add(spark)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2)
    sun.position.set(1, 2, 1.5)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(55, 1, 0.02, 200)
    camera.position.set(3, 2, 3)
    const scan = new THREE.Group()
    const panel = new THREE.Group()
    panel.visible = false
    scene.add(scan, panel)

    const ray = new THREE.Raycaster()
    const aim = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect()
      ray.setFromCamera(
        new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1),
        camera,
      )
      return ray
    }
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    let outline: { cx: number; cy: number; x: number; y: number } | null = null
    let move: { plane: THREE.Plane; offset: THREE.Vector3 } | null = null

    // Registered before OrbitControls so it can veto an orbit drag.
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (live.current.outlining) {
        outline = { cx: e.clientX, cy: e.clientY, ...local(e) }
        el.setPointerCapture(e.pointerId)
        return
      }
      const p = live.current.design.placement
      if (!p || !panel.visible) return
      const hit = aim(e.clientX, e.clientY).intersectObject(panel, true)[0]
      if (!hit) return
      const n = new THREE.Vector3(p.n[0], 0, p.n[1])
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, panel.position)
      const on = ray.ray.intersectPlane(plane, new THREE.Vector3())
      if (!on) return
      move = { plane, offset: on.sub(panel.position) }
      controls.enabled = false
      el.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (outline) {
        const q = local(e)
        setBox({
          x: Math.min(outline.x, q.x),
          y: Math.min(outline.y, q.y),
          w: Math.abs(q.x - outline.x),
          h: Math.abs(q.y - outline.y),
        })
      } else if (move) {
        const on = aim(e.clientX, e.clientY).ray.intersectPlane(move.plane, new THREE.Vector3())
        if (on) panel.position.copy(on.sub(move.offset))
      }
    }
    const onUp = (e: PointerEvent) => {
      if (outline) {
        const o = outline
        outline = null
        setBox(null)
        finishOutline(o.cx, o.cy, e.clientX, e.clientY)
      } else if (move) {
        move = null
        controls.enabled = true
        const p = live.current.design.placement
        if (p) live.current.onPlace({ ...p, c: panel.position.toArray() })
      }
    }

    const finishOutline = (x0: number, y0: number, x1: number, y1: number) => {
      if (Math.abs(x1 - x0) < 10 || Math.abs(y1 - y0) < 10) {
        setMsg('Drag a rectangle over the wall area.')
        return
      }
      // Sample the scan under the rectangle and fit the wall plane to it.
      scene.updateMatrixWorld(true)
      const pts: THREE.Vector3[] = []
      const N = 7
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const hit = aim(x0 + ((x1 - x0) * i) / (N - 1), y0 + ((y1 - y0) * j) / (N - 1)).intersectObject(
            scan,
            true,
          )[0]
          if (hit) pts.push(hit.point.clone())
        }
      }
      if (pts.length < 12) {
        setMsg('That rectangle mostly missed the scan. Try again over a wall.')
        return
      }
      const wall = fitWall(pts)
      if (!wall) {
        setMsg('That area is not one flat wall. Outline a smaller area on a single wall.')
        return
      }
      const { c, n } = wall
      if (n.dot(camera.position.clone().sub(c)) < 0) n.negate()
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, c)
      const a = aim(x0, y0).ray.intersectPlane(plane, new THREE.Vector3())
      const b = aim(x1, y1).ray.intersectPlane(plane, new THREE.Vector3())
      if (!a || !b) {
        setMsg('Could not project that rectangle onto the wall. Try a more head-on view.')
        return
      }
      const right = new THREE.Vector3().crossVectors(UP, n)
      const w = Math.round(Math.abs(b.clone().sub(a).dot(right)) / MM)
      const h = Math.round(Math.abs(b.y - a.y) / MM)
      if (w < 10 || h < 10) {
        setMsg('That area is too small.')
        return
      }
      const centre = a.add(b).multiplyScalar(0.5)
      live.current.onPlace({ c: centre.toArray(), n: [n.x, n.z] }, { w, h })
      setOutlining(false)
      setMsg(`Outlined ${fmt(w)} × ${fmt(h)} mm. Drag the panel to slide it along the wall.`)
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    const controls = new OrbitControls(camera, el)
    controls.enableDamping = true

    const mine: Stage = { renderer, camera, controls, scan, splat: null, panel, glow: [] }

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()
    renderer.setAnimationLoop(() => {
      controls.update()
      // The outline slowly fades in and out.
      const pulse = 0.5 - 0.5 * Math.cos(performance.now() / 700)
      for (const m of mine.glow) m.opacity = m.userData.base * pulse
      renderer.render(scene, camera)
    })

    stage.current = mine
    loadScan().then((saved) => {
      if (!saved || stage.current !== mine) return
      let r = 0
      try {
        r = Number(localStorage.getItem(ROT_KEY)) || 0
      } catch {
        // default orientation
      }
      showScan(saved.blob, saved.name, r)
    })

    return () => {
      stage.current = null
      renderer.setAnimationLoop(null)
      ro.disconnect()
      controls.dispose()
      clearScan(mine)
      disposeTree(panel)
      spark.dispose()
      renderer.dispose()
      el.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Orbiting is off while outlining.
  useEffect(() => {
    if (stage.current) stage.current.controls.enabled = !outlining
  }, [outlining])

  // Rebuild the panel whenever the design or its placement changes.
  useEffect(() => {
    const s = stage.current
    if (!s) return
    disposeTree(s.panel)
    s.panel.clear()
    const p = design.placement
    s.panel.visible = !!p
    if (!p) return
    const n = new THREE.Vector3(p.n[0], 0, p.n[1])
    const right = new THREE.Vector3().crossVectors(UP, n)
    s.panel.setRotationFromMatrix(new THREE.Matrix4().makeBasis(right, UP, n))
    s.panel.position.fromArray(p.c)

    const W = design.panel.w * MM
    const H = design.panel.h * MM
    // Invisible, but still there to grab when dragging the panel along the wall.
    const area = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    )
    area.position.z = WALL_GAP
    s.panel.add(area)

    // Glowing outline: a bright thin line with two soft halos around it.
    s.glow = []
    for (const [t, base] of [[0.004, 1], [0.02, 0.3], [0.05, 0.12]]) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe2a6,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      mat.userData.base = base
      s.glow.push(mat)
      for (const [w, h, x, y] of [
        [W + t, t, 0, H / 2],
        [W + t, t, 0, -H / 2],
        [t, H - t, -W / 2, 0],
        [t, H - t, W / 2, 0],
      ]) {
        const edge = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
        edge.position.set(x, y, WALL_GAP + 0.001)
        s.panel.add(edge)
      }
    }
    const wood = new THREE.MeshLambertMaterial({ color: 0xd9b382 })
    for (const m of design.members) {
      const r = rectOf(m, design.stocks)
      const w = (r.x1 - r.x0) * MM
      const h = (r.y1 - r.y0) * MM
      const d = depthOf(m, design.stocks) * MM
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood)
      mesh.position.set(r.x0 * MM + w / 2 - W / 2, H / 2 - (r.y0 * MM + h / 2), WALL_GAP + d / 2)
      s.panel.add(mesh)
    }
  }, [design])

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    setMsg(`Loading ${file.name}…`)
    // Splat files are usually stored upside down relative to this viewer.
    if (await showScan(file, file.name, isSplatFile(file.name) ? 2 : 0)) {
      onScanReplaced()
      await saveScan({ blob: file, name: file.name }).catch(() =>
        setMsg('Scan loaded, but it could not be saved for next time.'),
      )
    }
  }

  return (
    <div className="room">
      <div className="room-stage" ref={hostRef} style={{ cursor: outlining ? 'crosshair' : 'grab' }} />
      {box && (
        <div className="room-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
      )}
      <div className="room-bar">
        <label className="filebtn">
          {hasScan ? 'Replace scan' : 'Load scan'}
          <input
            type="file"
            accept=".glb,.ply,.spz"
            onChange={(e) => {
              pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
        {hasScan && (
          <>
            <button
              title="Use this if the room is upside down or on its side"
              onClick={() => {
                orient((rot + 1) % 4)
                onScanReplaced()
              }}
            >
              Turn upright
            </button>
            <button className={outlining ? 'on' : ''} onClick={() => setOutlining((v) => !v)}>
              {outlining ? 'Cancel outline' : 'Outline area'}
            </button>
          </>
        )}
        <span className="room-msg">
          {outlining ? 'Drag a rectangle over the wall where the changho will hang.' : msg}
        </span>
      </div>
      {!hasScan && (
        <div className="room-empty">
          <p>
            <b>No scan loaded.</b>
          </p>
          <p>
            Scan the wall and its surroundings with a LiDAR scanner app on your iPhone, export it as
            a splat (SPZ or PLY) or a mesh (GLB), send it to this Mac and load it here.
          </p>
        </div>
      )}
    </div>
  )
}
