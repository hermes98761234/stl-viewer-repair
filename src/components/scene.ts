import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { bbox, type Axis, type Mesh, type Vec3 } from '../lib/mesh'
import type { Analysis } from '../lib/topology'

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]

/** Imperative three.js scene for the model viewport. React drives it through the setters. */
export class SceneController {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000)
  private controls: OrbitControls
  private front: THREE.Mesh | null = null
  private back: THREE.Mesh | null = null
  private frontMat = new THREE.MeshStandardMaterial({ color: 0x8fa8cc, flatShading: true, roughness: 0.6, metalness: 0.05, side: THREE.FrontSide })
  private backMat = new THREE.MeshBasicMaterial({ color: 0xe5484d, side: THREE.BackSide })
  private grid: THREE.GridHelper | null = null
  private overlay = new THREE.Group()
  private sectionGroup = new THREE.Group()
  private measureGroup = new THREE.Group()
  private radius = 50
  private center = new THREE.Vector3()
  private raycaster = new THREE.Raycaster()
  private ro: ResizeObserver
  private down: [number, number] | null = null
  private frame = 0
  private disposed = false

  private host: HTMLElement
  private onPick: (p: Vec3) => void

  constructor(host: HTMLElement, onPick: (p: Vec3) => void) {
    this.host = host
    this.onPick = onPick
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.localClippingEnabled = true
    host.appendChild(this.renderer.domElement)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(60, -80, 50)
    this.scene.add(this.camera, this.overlay, this.sectionGroup, this.measureGroup)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(0.4, -0.6, 1)
    this.camera.add(key)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = false
    this.controls.addEventListener('change', () => this.render())
    this.renderer.domElement.addEventListener('pointerdown', (e) => (this.down = [e.clientX, e.clientY]))
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (this.down && Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 4) this.pick(e)
      this.down = null
    })
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    this.setTheme()
  }

  private render() {
    if (this.disposed || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderer.render(this.scene, this.camera)
    })
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.render()
  }

  /** Re-reads the background from the CSS variables, for theme changes. */
  setTheme() {
    const bg = getComputedStyle(this.host).getPropertyValue('--chart-bg').trim() || '#0b0d11'
    this.scene.background = new THREE.Color(bg)
    const dark = new THREE.Color(bg).getHSL({ h: 0, s: 0, l: 0 }).l < 0.5
    if (this.grid) (this.grid.material as THREE.LineBasicMaterial).color.set(dark ? 0x3a4254 : 0xb4bac6)
    this.render()
  }

  setMesh(mesh: Mesh, fit: boolean) {
    for (const m of [this.front, this.back]) {
      if (m) {
        this.scene.remove(m)
        if (m === this.front) m.geometry.dispose()
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    this.front = new THREE.Mesh(geo, this.frontMat)
    this.back = new THREE.Mesh(geo, this.backMat)
    this.scene.add(this.front, this.back)
    const { min, max } = bbox(mesh)
    const size = new THREE.Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2])
    this.center.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    this.radius = Math.max(size.length() / 2, 1e-3)
    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.geometry.dispose()
    }
    const extent = Math.max(size.x, size.y, size.z, 1e-3)
    const step = 10 ** Math.floor(Math.log10(extent / 5))
    const gs = Math.ceil((extent * 2) / step / 2) * 2 * step
    this.grid = new THREE.GridHelper(gs, Math.round(gs / step), 0xffffff, 0xffffff)
    this.grid.rotation.x = Math.PI / 2
    this.grid.position.set(this.center.x, this.center.y, min[2])
    this.scene.add(this.grid)
    this.camera.near = this.radius / 200
    this.camera.far = this.radius * 200
    this.camera.updateProjectionMatrix()
    this.setTheme()
    if (fit) this.resetView()
    this.render()
  }

  resetView() {
    const d = this.radius / Math.sin((this.camera.fov * Math.PI) / 360)
    const dir = new THREE.Vector3(0.6, -0.8, 0.55).normalize()
    this.camera.position.copy(this.center).addScaledVector(dir, d * 1.05)
    this.controls.target.copy(this.center)
    this.controls.update()
    this.render()
  }

  setWireframe(on: boolean) {
    this.frontMat.wireframe = on
    this.render()
  }

  setOverlays(a: Analysis | null, show: boolean) {
    this.clear(this.overlay)
    if (a && show) {
      const add = (pos: Float32Array, color: number) => {
        if (pos.length === 0) return
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }))
        l.renderOrder = 10
        this.overlay.add(l)
      }
      add(a.boundaryLines, 0xff2d2d)
      add(a.nonManifoldLines, 0xff00ff)
      add(a.inconsistentLines, 0xffd400)
    }
    this.render()
  }

  /** Cuts away the part above `offset` along `axis`. */
  setClip(axis: Axis, offset: number, on: boolean) {
    const planes = on ? [new THREE.Plane(AXES[axis].clone().negate(), offset)] : []
    this.frontMat.clippingPlanes = planes
    this.backMat.clippingPlanes = planes
    this.frontMat.needsUpdate = this.backMat.needsUpdate = true
    this.render()
  }

  setSection(loops: Float32Array[]) {
    this.clear(this.sectionGroup)
    for (const l of loops) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(l, 3))
      const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x00d1ff, depthTest: false }))
      line.renderOrder = 11
      this.sectionGroup.add(line)
    }
    this.render()
  }

  setMeasure(points: Vec3[]) {
    this.clear(this.measureGroup)
    const r = this.radius * 0.012
    for (const p of points) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }))
      s.position.set(...p)
      s.renderOrder = 12
      this.measureGroup.add(s)
    }
    if (points.length === 2) {
      const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)))
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }))
      l.renderOrder = 12
      this.measureGroup.add(l)
    }
    this.render()
  }

  private pick(e: PointerEvent) {
    if (!this.front || !this.back) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const clip = this.frontMat.clippingPlanes ?? []
    const hits = this.raycaster.intersectObjects([this.front, this.back], false).filter((h) => clip.every((pl) => pl.distanceToPoint(h.point) >= 0))
    if (hits.length) this.onPick([hits[0].point.x, hits[0].point.y, hits[0].point.z])
  }

  /** PNG of the current view. */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  private clear(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c)
      const o = c as THREE.Mesh
      o.geometry?.dispose()
      ;(o.material as THREE.Material)?.dispose()
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.ro.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
