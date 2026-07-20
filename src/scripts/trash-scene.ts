import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.getElementById("trash-canvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("trash-canvas not found");

// Ensure only one instance runs (HMR / double-injection safe)
const globalScope = window as unknown as { __trashSceneCleanup?: () => void };
globalScope.__trashSceneCleanup?.();

let rafId = 0;
let alive = true; // false once this instance is torn down (HMR-safe)

const scene = new THREE.Scene();
// no fog — models stay crisp and fully solid

const camera = new THREE.PerspectiveCamera(
	50,
	window.innerWidth / window.innerHeight,
	0.1,
	100,
);
camera.position.set(0, 0, 14);

const renderer = new THREE.WebGLRenderer({
	canvas,
	alpha: true,
	antialias: true,
	powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

// --- lighting: bright + colorful so the painted PS1 textures pop ---
scene.add(new THREE.AmbientLight(0xffffff, 1.0));

const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(-4, 6, 8);
scene.add(key);

const pink = new THREE.PointLight(0xff8fc4, 16, 40);
pink.position.set(-6, 4, 6);
scene.add(pink);

const gold = new THREE.PointLight(0xffe08a, 14, 40);
gold.position.set(6, -3, 5);
scene.add(gold);

const cyan = new THREE.PointLight(0x7fd8ff, 12, 40);
cyan.position.set(0, 6, -4);
scene.add(cyan);

// --- config ---
// Model list is discovered at build time and injected via the canvas data
// attribute — drop a new .glb into /public/models and it appears, no code edits.
// These four source GLBs have scene transforms that do not behave as portable
// game objects. Keep the files for later replacement, but do not spawn them.
const EXCLUDED_MODELS = new Set([
	"goose", "pig", "shark", "cockroach",
	// These imports have extreme or inconsistent transforms in the game field.
	"cavalo_no_estilo_de_ps1", "eva_01_ps1", "pixelated_pig_horror",
]);
const MODEL_FILES: string[] = (JSON.parse(canvas.dataset.models || "[]") as string[])
	.filter((name) => !EXCLUDED_MODELS.has(name));
if (MODEL_FILES.length === 0) {
	console.warn("No models found — add .glb files to /public/models");
}

const TARGET_SIZE = 2.35; // keep every object comfortably clickable in-frame
const COUNT = 20;
const bounds = { x: 9.2, y: 5.2, z: 3.2 };
// hard slab the pieces are confined to, so nothing can rush the camera and
// appear as a giant unclickable blob before vanishing behind it
const Z_MIN = -4.5;
const Z_MAX = 1.5; // camera sits at z=14, so pieces stay >=12.5 units away
const MAX_SPEED = 8.4;

const FLEE_RADIUS = 3.8;
const FLEE_ACCEL = 40;
const HOME_K = 1.35;
const WANDER = 4.5;
const PANIC_DURATION = 0.5;
const TARGET_SCORE = 20;
let score = 0;
let gameComplete = false;

const confettiColors = [
	0xff5d8f, 0xffd23f, 0x3bd6c6, 0x6c8cff, 0xa06bff,
	0xff8a3d, 0x63e06a, 0xffffff,
];

// --- load + normalize every model into a reusable prototype ---

type Prototype = { name: string; holder: THREE.Group };

function prepPrototype(gltf: { scene: THREE.Group }, name: string): Prototype {
	const root = gltf.scene;
	root.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(root);
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	const maxDim = Math.max(size.x, size.y, size.z) || 1;
	const scale = TARGET_SIZE / maxDim;

	// Keep the GLB's own transform intact. Several models have a non-identity
	// scene root, so subtracting a world-space bounding-box centre from
	// `root.position` moved their visible mesh away from its click group.
	const centreOffset = new THREE.Group();
	centreOffset.position.copy(center).multiplyScalar(-1);
	centreOffset.add(root);
	const holder = new THREE.Group();
	holder.add(centreOffset);
	holder.scale.setScalar(scale);
	return { name, holder };
}

const loader = new GLTFLoader();
function loadModel(name: string): Promise<Prototype | null> {
	return new Promise((resolve) => {
		loader.load(
			`/models/${name}.glb`,
			(gltf) => resolve(prepPrototype(gltf as { scene: THREE.Group }, name)),
			undefined,
			(err) => {
				console.warn(`Failed to load ${name}.glb`, err);
				resolve(null);
			},
		);
	});
}

// --- pieces ---

type Piece = {
	group: THREE.Group;
	materials: THREE.Material[];
	hitGeometry: THREE.BufferGeometry;
	velocity: THREE.Vector3;
	home: THREE.Vector3;
	spin: THREE.Vector3;
	wander: THREE.Vector3;
	burst: number;
	state: "spawning" | "alive" | "panic";
	panicT: number;
	targetScale: number;
};

const pieces: Piece[] = [];
let prototypes: Prototype[] = [];

// shuffle-bag: draw every model once before repeating, so all of them appear
let protoBag: Prototype[] = [];
function nextPrototype(): Prototype {
	if (protoBag.length === 0) {
		protoBag = [...prototypes];
		for (let i = protoBag.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[protoBag[i], protoBag[j]] = [protoBag[j], protoBag[i]];
		}
	}
	return protoBag.pop() as Prototype;
}

const HOME_SLOTS = [
	// A full field on purpose: objects may cross the title window now.
	[-5.1, 2.8], [-2.5, 2.8], [0, 2.8], [2.5, 2.8], [5.1, 2.8],
	[-5.1, 0.9], [-2.5, 0.9], [0, 0.9], [2.5, 0.9], [5.1, 0.9],
	[-5.1, -0.9], [-2.5, -0.9], [0, -0.9], [2.5, -0.9], [5.1, -0.9],
	[-5.1, -2.7], [-2.5, -2.7], [0, -2.7], [2.5, -2.7], [5.1, -2.7],
] as const;

function randomHome() {
	// Explicit slots make the game readable: no stack of models in the middle,
	// no impossible hit targets, and the title window keeps a clear corner.
	const openSlots = HOME_SLOTS.filter(([x, y]) =>
		pieces.every((piece) => Math.hypot(piece.home.x - x, piece.home.y - y) > 1.7),
	);
	const [x, y] = openSlots[Math.floor(Math.random() * openSlots.length)] ?? HOME_SLOTS[0];
	return new THREE.Vector3(
		x + (Math.random() - 0.5) * 0.35,
		y + (Math.random() - 0.5) * 0.3,
		-2.1 + Math.random() * 1.3,
	);
}

function spawnPiece(home = randomHome()) {
	if (!alive || prototypes.length === 0) return;
	const proto = nextPrototype();
	const group = proto.holder.clone(true);
	// per-piece size variety so the field doesn't look uniform
	const targetScale = group.scale.x * (0.78 + Math.random() * 0.32);

	const materials: THREE.Material[] = [];
	group.traverse((o) => {
		const mesh = o as THREE.Mesh;
		if (mesh.isMesh) {
			const mat = (mesh.material as THREE.Material).clone();
			mat.transparent = false; // fully solid, never see-through
			mat.opacity = 1;
			mat.depthWrite = true;
			mat.needsUpdate = true;
			mesh.frustumCulled = false;
			mesh.material = mat;
			materials.push(mat);
		}
	});

	group.position.copy(home);
	group.rotation.set(
		Math.random() * Math.PI,
		Math.random() * Math.PI,
		Math.random() * Math.PI,
	);
	group.scale.setScalar(0.01); // pop-in
	// Some of the hand-made GLBs render correctly but have geometry that their
	// triangle raycast cannot hit. A transparent sphere gives every model the
	// same generous, reliable click area without changing how it looks.
	const hitMaterial = new THREE.MeshBasicMaterial({
		transparent: true,
		opacity: 0,
		depthWrite: false,
		side: THREE.DoubleSide,
	});
	const hitGeometry = new THREE.SphereGeometry((TARGET_SIZE * 1.15) / targetScale, 12, 8);
	const hitTarget = new THREE.Mesh(hitGeometry, hitMaterial);
	hitTarget.name = "click-target";
	group.add(hitTarget);
	materials.push(hitMaterial);

	const piece: Piece = {
		group,
		materials,
		hitGeometry,
		velocity: new THREE.Vector3(),
		home,
		spin: new THREE.Vector3(
			(Math.random() - 0.5) * 1.3,
			(Math.random() - 0.5) * 1.3,
			(Math.random() - 0.5) * 1.3,
		),
		wander: new THREE.Vector3(
			Math.random() * 10,
			Math.random() * 10,
			Math.random() * 10,
		),
		burst: confettiColors[Math.floor(Math.random() * confettiColors.length)],
		state: "spawning",
		panicT: 0,
		targetScale,
	};
	group.userData.piece = piece;
	scene.add(group);
	pieces.push(piece);
	return piece;
}

// --- explosion shards ---

type Shard = {
	mesh: THREE.Mesh;
	material: THREE.MeshStandardMaterial;
	velocity: THREE.Vector3;
	angular: THREE.Vector3;
	life: number;
	maxLife: number;
};

const shards: Shard[] = [];
const shardGeo = new THREE.TetrahedronGeometry(0.24, 0);

function explode(piece: Piece) {
	const origin = piece.group.position.clone();
	const count = 16 + Math.floor(Math.random() * 10);
	for (let i = 0; i < count; i++) {
		const color =
			i % 3 === 0
				? piece.burst
				: confettiColors[Math.floor(Math.random() * confettiColors.length)];
		const material = new THREE.MeshStandardMaterial({
			color,
			flatShading: true,
			roughness: 0.5,
			transparent: true,
		});
		const mesh = new THREE.Mesh(shardGeo, material);
		mesh.position.copy(origin);
		mesh.scale.setScalar(0.5 + Math.random());
		const dir = new THREE.Vector3(
			Math.random() - 0.5,
			Math.random() - 0.5,
			Math.random() - 0.5,
		).normalize();
		scene.add(mesh);
		shards.push({
			mesh,
			material,
			velocity: dir.multiplyScalar(5 + Math.random() * 6),
			angular: new THREE.Vector3(
				(Math.random() - 0.5) * 14,
				(Math.random() - 0.5) * 14,
				(Math.random() - 0.5) * 14,
			),
			life: 0,
			maxLife: 0.9 + Math.random() * 0.5,
		});
	}

	scene.remove(piece.group);
	for (const m of piece.materials) m.dispose();
	piece.hitGeometry.dispose();
	const idx = pieces.indexOf(piece);
	if (idx !== -1) pieces.splice(idx, 1);
	score += 1;
	window.dispatchEvent(
		new CustomEvent("trash:score", { detail: { score, target: TARGET_SCORE } }),
	);
	if (score >= TARGET_SCORE) {
		gameComplete = true;
		window.dispatchEvent(new CustomEvent("trash:complete"));
	}
	window.setTimeout(() => {
		if (alive && !gameComplete) spawnPiece();
	}, 500 + Math.random() * 900);
}

// --- pointer / interaction ---

const pointerNdc = new THREE.Vector2();
let hasPointer = false;
const raycaster = new THREE.Raycaster();
const cursorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const cursorWorld = new THREE.Vector3(999, 999, 0);
const card = document.querySelector(".game-ui") as HTMLElement | null;
let cardBounds = card?.getBoundingClientRect();

function updateCardBounds() {
	cardBounds = card?.getBoundingClientRect();
}

function onPointerMove(event: PointerEvent) {
	pointerNdc.x = (event.clientX / window.innerWidth) * 2 - 1;
	pointerNdc.y = -(event.clientY / window.innerHeight) * 2 + 1;
	hasPointer = true;
}

function onPointerDown(event: PointerEvent) {
	if (gameComplete) return;
	// derive NDC from the event itself — a tap may not fire pointermove first
	pointerNdc.x = (event.clientX / window.innerWidth) * 2 - 1;
	pointerNdc.y = -(event.clientY / window.innerHeight) * 2 + 1;
	hasPointer = true;
	raycaster.setFromCamera(pointerNdc, camera);
	const hits = raycaster.intersectObjects(
		pieces.map((p) => p.group),
		true,
	);
	// Do not let an already-popping foreground model swallow every click behind
	// it. This is what made the pig, shark, and cockroach appear unclickable.
	let piece: Piece | undefined;
	for (const hit of hits) {
		let o: THREE.Object3D | null = hit.object;
		while (o && !o.userData.piece) o = o.parent;
		const candidate = o?.userData.piece as Piece | undefined;
		if (candidate && candidate.state !== "panic") {
			piece = candidate;
			break;
		}
	}
	if (!piece) return;
	piece.state = "panic";
	piece.panicT = 0;
	// launch a startled kick away from the cursor
	const away = piece.group.position.clone().sub(cursorWorld);
	away.z = 0;
	piece.velocity.addScaledVector(away.normalize(), 3.6);
}

function onResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
	updateCardBounds();
}

window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerdown", onPointerDown);
window.addEventListener("resize", onResize);

// --- main loop ---

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
const screenPoint = new THREE.Vector3();

function bounceOffCard(piece: Piece) {
	if (!cardBounds) return;
	screenPoint.copy(piece.group.position).project(camera);
	const x = (screenPoint.x * 0.5 + 0.5) * window.innerWidth;
	const y = (-screenPoint.y * 0.5 + 0.5) * window.innerHeight;
	// Use a generous bumper because several low-poly models are much wider than
	// their origin; they should reverse before their visible geometry reaches
	// the title window.
	const padding = 110;
	if (
		x < cardBounds.left - padding || x > cardBounds.right + padding ||
		y < cardBounds.top - padding || y > cardBounds.bottom + padding
	) return;

	const distances = [
		Math.abs(x - cardBounds.left), Math.abs(cardBounds.right - x),
		Math.abs(y - cardBounds.top), Math.abs(cardBounds.bottom - y),
	];
	const side = distances.indexOf(Math.min(...distances));
	if (side === 0) piece.velocity.x = -Math.max(Math.abs(piece.velocity.x), 2.8);
	if (side === 1) piece.velocity.x = Math.max(Math.abs(piece.velocity.x), 2.8);
	if (side === 2) piece.velocity.y = Math.max(Math.abs(piece.velocity.y), 2.8);
	if (side === 3) piece.velocity.y = -Math.max(Math.abs(piece.velocity.y), 2.8);
}

function animate() {
	const dt = Math.min(clock.getDelta(), 0.05);
	const t = clock.elapsedTime;

	// update cursor world point on the z=0 plane
	if (hasPointer) {
		raycaster.setFromCamera(pointerNdc, camera);
		raycaster.ray.intersectPlane(cursorPlane, cursorWorld);
	}

	// pieces whose panic finished this frame — exploded after the loop so we
	// never mutate `pieces` while iterating it
	const toExplode: Piece[] = [];

	for (const piece of pieces) {
		const g = piece.group;

		// pop-in scaling
		if (piece.state === "spawning") {
			const s = Math.min(piece.targetScale, g.scale.x + dt * piece.targetScale * 3);
			g.scale.setScalar(s);
			if (s >= piece.targetScale - 1e-3) piece.state = "alive";
		}

		if (piece.state === "panic") {
			piece.panicT += dt;
			// freak out: violent shake, rapid spin, scale pulse
			const shake = 0.12;
			g.position.x += (Math.random() - 0.5) * shake;
			g.position.y += (Math.random() - 0.5) * shake;
			const pulse =
				piece.targetScale * (1 + Math.sin(piece.panicT * 55) * 0.22);
			g.scale.setScalar(pulse);
			g.rotation.x += 22 * dt;
			g.rotation.y += 28 * dt;
			g.rotation.z += 18 * dt;
			if (piece.panicT >= PANIC_DURATION) toExplode.push(piece);
			continue;
		}

		// --- drift forces (alive + spawning) ---
		const v = piece.velocity;

		// wander
		v.x += Math.sin(t * 0.6 + piece.wander.x) * WANDER * dt;
		v.y += Math.sin(t * 0.5 + piece.wander.y) * WANDER * dt;
		v.z += Math.sin(t * 0.4 + piece.wander.z) * WANDER * dt * 0.5;

		// spring toward home
		tmp.copy(piece.home).sub(g.position);
		v.addScaledVector(tmp, HOME_K * dt);

		// flee from cursor (planar)
		let scare = 0;
		if (hasPointer) {
			tmp.copy(g.position).sub(cursorWorld);
			tmp.z = 0;
			const d = tmp.length();
			if (d < FLEE_RADIUS) {
				scare = 1 - d / FLEE_RADIUS;
				v.addScaledVector(tmp.normalize(), scare * FLEE_ACCEL * dt);
			}
		}

		// damping + speed cap + integrate
		v.multiplyScalar(Math.exp(-1.3 * dt));
		if (v.lengthSq() > MAX_SPEED * MAX_SPEED) v.setLength(MAX_SPEED);
		g.position.addScaledVector(v, dt);
		bounceOffCard(piece);

		// hard containment — reflect softly off the walls so a piece can never
		// rush the camera (huge unclickable blob) or fly off screen
		if (g.position.x < -bounds.x) {
			g.position.x = -bounds.x;
			v.x *= -0.4;
		} else if (g.position.x > bounds.x) {
			g.position.x = bounds.x;
			v.x *= -0.4;
		}
		if (g.position.y < -bounds.y) {
			g.position.y = -bounds.y;
			v.y *= -0.4;
		} else if (g.position.y > bounds.y) {
			g.position.y = bounds.y;
			v.y *= -0.4;
		}
		if (g.position.z < Z_MIN) {
			g.position.z = Z_MIN;
			v.z *= -0.4;
		} else if (g.position.z > Z_MAX) {
			g.position.z = Z_MAX;
			v.z *= -0.4;
		}

		// spin — faster when scared
		const spinBoost = 1 + scare * 8;
		g.rotation.x += piece.spin.x * dt * spinBoost;
		g.rotation.y += piece.spin.y * dt * spinBoost;
		g.rotation.z += piece.spin.z * dt * spinBoost;
	}

	// now safe to remove/respawn — iteration over `pieces` is done
	for (const piece of toExplode) explode(piece);

	// shards
	for (let i = shards.length - 1; i >= 0; i--) {
		const shard = shards[i];
		shard.life += dt;
		shard.velocity.y -= 7 * dt;
		shard.velocity.multiplyScalar(0.98);
		shard.mesh.position.addScaledVector(shard.velocity, dt);
		shard.mesh.rotation.x += shard.angular.x * dt;
		shard.mesh.rotation.y += shard.angular.y * dt;
		shard.mesh.rotation.z += shard.angular.z * dt;
		const k = shard.life / shard.maxLife;
		shard.material.opacity = Math.max(0, 1 - k);
		shard.mesh.scale.multiplyScalar(1 - dt * 0.6);
		if (shard.life >= shard.maxLife) {
			scene.remove(shard.mesh);
			shard.material.dispose();
			shards.splice(i, 1);
		}
	}

	// gentle camera parallax
	const px = hasPointer ? pointerNdc.x : 0;
	const py = hasPointer ? pointerNdc.y : 0;
	camera.position.x += (px * 1.1 - camera.position.x) * 0.02;
	camera.position.y += (py * 0.7 - camera.position.y) * 0.02;
	camera.lookAt(0, 0, 0);

	renderer.render(scene, camera);
	rafId = requestAnimationFrame(animate);
}

// --- boot ---
Promise.all(MODEL_FILES.map(loadModel)).then((loaded) => {
	if (!alive) return; // this instance was torn down while models loaded
	prototypes = loaded.filter((p): p is Prototype => p !== null);
	if (prototypes.length === 0) {
		console.error("No models loaded.");
		return;
	}
	for (let i = 0; i < COUNT; i++) spawnPiece();
});

animate();

// --- teardown so exactly one instance is ever live ---
function cleanup() {
	alive = false; // stops any pending async spawns from this instance
	cancelAnimationFrame(rafId);
	window.removeEventListener("pointermove", onPointerMove);
	window.removeEventListener("pointerdown", onPointerDown);
	window.removeEventListener("resize", onResize);
	for (const piece of pieces) scene.remove(piece.group);
	for (const shard of shards) scene.remove(shard.mesh);
	renderer.dispose();
}
globalScope.__trashSceneCleanup = cleanup;

if (import.meta.hot) {
	import.meta.hot.dispose(() => cleanup());
}
