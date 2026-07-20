import * as THREE from "three";

const canvas = document.getElementById("trash-canvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("trash-canvas not found");

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xfaf6f0, 0.022);

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
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// --- brighter lighting so the vivid materials read as saturated ---
scene.add(new THREE.AmbientLight(0xffffff, 0.9));

const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(-4, 6, 8);
scene.add(key);

const pink = new THREE.PointLight(0xff8fc4, 18, 30);
pink.position.set(-6, 4, 6);
scene.add(pink);

const gold = new THREE.PointLight(0xffe08a, 16, 30);
gold.position.set(6, -3, 5);
scene.add(gold);

const cyan = new THREE.PointLight(0x7fd8ff, 14, 30);
cyan.position.set(0, 6, -4);
scene.add(cyan);

// --- geometry helpers: low-poly "crumpled" primitives ---

function jitterGeometry(geometry: THREE.BufferGeometry, amount: number) {
	const position = geometry.attributes.position;
	const vertex = new THREE.Vector3();
	for (let i = 0; i < position.count; i++) {
		vertex.fromBufferAttribute(position, i);
		vertex.x += (Math.random() - 0.5) * amount;
		vertex.y += (Math.random() - 0.5) * amount;
		vertex.z += (Math.random() - 0.5) * amount;
		position.setXYZ(i, vertex.x, vertex.y, vertex.z);
	}
	geometry.computeVertexNormals();
	return geometry;
}

function crumpledBall(radius: number) {
	return jitterGeometry(new THREE.IcosahedronGeometry(radius, 1), radius * 0.16);
}
function crumpledCan(radius: number, height: number) {
	return jitterGeometry(
		new THREE.CylinderGeometry(radius, radius * 0.9, height, 8, 3),
		radius * 0.1,
	);
}
function crumpledBox(size: number) {
	return jitterGeometry(new THREE.BoxGeometry(size, size, size, 2, 2, 2), size * 0.12);
}
function crumpledBottle(radius: number, height: number) {
	return jitterGeometry(
		new THREE.CylinderGeometry(radius * 0.4, radius, height, 7, 4),
		radius * 0.08,
	);
}

// --- vivid palette + procedural "painted patch" textures for the PS1 look ---

const vividPalette = [
	{ base: "#3b6dd6", patch: ["#7fb0ff", "#1e3f8f", "#ffffff"] }, // shark blue
	{ base: "#c1622a", patch: ["#e79b52", "#8f3d15", "#f4d9a0"] }, // monkey brown
	{ base: "#3f7d4f", patch: ["#8fce77", "#1e4d2b", "#d7e8a0"] }, // duck green
	{ base: "#d94f4f", patch: ["#ff8a8a", "#9c2020", "#ffd34d"] }, // ketchup red
	{ base: "#e8b53a", patch: ["#fff0a0", "#b07d12", "#ff9d3a"] }, // crab yellow
	{ base: "#e6e9ef", patch: ["#ffffff", "#b9c2d6", "#4a5468"] }, // seagull white
	{ base: "#8a4fd6", patch: ["#c79bff", "#4a1e8f", "#ff9de0"] }, // grape violet
	{ base: "#28c0c0", patch: ["#8ff0f0", "#0d6d6d", "#ffffff"] }, // teal
];

function paintedTexture(scheme: { base: string; patch: string[] }) {
	const size = 128;
	const c = document.createElement("canvas");
	c.width = c.height = size;
	const ctx = c.getContext("2d")!;
	ctx.fillStyle = scheme.base;
	ctx.fillRect(0, 0, size, size);
	for (let i = 0; i < 26; i++) {
		ctx.fillStyle = scheme.patch[i % scheme.patch.length];
		ctx.globalAlpha = 0.35 + Math.random() * 0.5;
		ctx.beginPath();
		ctx.ellipse(
			Math.random() * size,
			Math.random() * size,
			4 + Math.random() * 22,
			4 + Math.random() * 22,
			Math.random() * Math.PI,
			0,
			Math.PI * 2,
		);
		ctx.fill();
	}
	ctx.globalAlpha = 1;
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

type TrashPiece = {
	mesh: THREE.Mesh;
	material: THREE.MeshStandardMaterial;
	basePosition: THREE.Vector3;
	bobSpeed: number;
	bobOffset: number;
	rotSpeed: THREE.Vector3;
	driftSpeed: THREE.Vector3;
	scheme: { base: string; patch: string[] };
};

const pieces: TrashPiece[] = [];
const builders = [
	() => crumpledBall(0.6 + Math.random() * 0.5),
	() => crumpledCan(0.35 + Math.random() * 0.2, 1 + Math.random() * 0.6),
	() => crumpledBox(0.6 + Math.random() * 0.5),
	() => crumpledBottle(0.4 + Math.random() * 0.25, 1.3 + Math.random() * 0.7),
];

const TRASH_COUNT = 22;
const bounds = { x: 9, y: 6, z: 6 };

function randomBasePosition() {
	return new THREE.Vector3(
		(Math.random() - 0.5) * bounds.x * 2,
		(Math.random() - 0.5) * bounds.y * 2,
		(Math.random() - 0.5) * bounds.z * 2 - 2,
	);
}

function spawnPiece(basePosition = randomBasePosition()) {
	const geometry = builders[Math.floor(Math.random() * builders.length)]();
	const scheme = vividPalette[Math.floor(Math.random() * vividPalette.length)];
	const material = new THREE.MeshStandardMaterial({
		map: paintedTexture(scheme),
		flatShading: true,
		roughness: 0.55,
		metalness: 0.1,
		transparent: true,
	});
	const mesh = new THREE.Mesh(geometry, material);
	mesh.position.copy(basePosition);
	mesh.rotation.set(
		Math.random() * Math.PI,
		Math.random() * Math.PI,
		Math.random() * Math.PI,
	);
	mesh.scale.setScalar(0.01); // pop-in
	scene.add(mesh);

	const piece: TrashPiece = {
		mesh,
		material,
		basePosition,
		bobSpeed: 0.4 + Math.random() * 0.5,
		bobOffset: Math.random() * Math.PI * 2,
		rotSpeed: new THREE.Vector3(
			(Math.random() - 0.5) * 0.3,
			(Math.random() - 0.5) * 0.3,
			(Math.random() - 0.5) * 0.3,
		),
		driftSpeed: new THREE.Vector3(
			(Math.random() - 0.5) * 0.05,
			(Math.random() - 0.5) * 0.05,
			(Math.random() - 0.5) * 0.05,
		),
		scheme,
	};
	pieces.push(piece);
	return piece;
}

for (let i = 0; i < TRASH_COUNT; i++) spawnPiece();

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
const shardGeo = new THREE.TetrahedronGeometry(0.22, 0);

function explode(piece: TrashPiece) {
	const origin = piece.mesh.position.clone();
	const count = 14 + Math.floor(Math.random() * 8);
	for (let i = 0; i < count; i++) {
		const material = new THREE.MeshStandardMaterial({
			color: new THREE.Color(
				piece.scheme.patch[i % piece.scheme.patch.length],
			),
			flatShading: true,
			roughness: 0.5,
			transparent: true,
		});
		const mesh = new THREE.Mesh(shardGeo, material);
		mesh.position.copy(origin);
		mesh.scale.setScalar(0.5 + Math.random() * 0.9);
		const dir = new THREE.Vector3(
			Math.random() - 0.5,
			Math.random() - 0.5,
			Math.random() - 0.5,
		).normalize();
		scene.add(mesh);
		shards.push({
			mesh,
			material,
			velocity: dir.multiplyScalar(4 + Math.random() * 5),
			angular: new THREE.Vector3(
				(Math.random() - 0.5) * 12,
				(Math.random() - 0.5) * 12,
				(Math.random() - 0.5) * 12,
			),
			life: 0,
			maxLife: 0.9 + Math.random() * 0.5,
		});
	}

	// remove the piece and respawn a fresh one shortly after
	scene.remove(piece.mesh);
	piece.material.map?.dispose();
	piece.material.dispose();
	piece.mesh.geometry.dispose();
	const idx = pieces.indexOf(piece);
	if (idx !== -1) pieces.splice(idx, 1);
	window.setTimeout(() => spawnPiece(), 600 + Math.random() * 900);
}

// --- interaction: click / tap to explode ---

const raycaster = new THREE.Raycaster();
const clickNdc = new THREE.Vector2();

function handleClick(clientX: number, clientY: number) {
	clickNdc.x = (clientX / window.innerWidth) * 2 - 1;
	clickNdc.y = -(clientY / window.innerHeight) * 2 + 1;
	raycaster.setFromCamera(clickNdc, camera);
	const meshes = pieces.map((p) => p.mesh);
	const hits = raycaster.intersectObjects(meshes, false);
	if (hits.length > 0) {
		const hitMesh = hits[0].object;
		const piece = pieces.find((p) => p.mesh === hitMesh);
		if (piece) explode(piece);
	}
}

window.addEventListener("pointerdown", (event) => {
	handleClick(event.clientX, event.clientY);
});

// --- gentle mouse parallax ---
const pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (event) => {
	pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
	pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
});

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

function animate() {
	const dt = Math.min(clock.getDelta(), 0.05);
	const t = clock.elapsedTime;

	for (const piece of pieces) {
		piece.mesh.position.x =
			piece.basePosition.x + Math.sin(t * piece.driftSpeed.x * 10) * 0.6;
		piece.mesh.position.y =
			piece.basePosition.y +
			Math.sin(t * piece.bobSpeed + piece.bobOffset) * 0.4;
		piece.mesh.position.z =
			piece.basePosition.z + Math.cos(t * piece.driftSpeed.z * 10) * 0.6;

		piece.mesh.rotation.x += piece.rotSpeed.x * 0.01;
		piece.mesh.rotation.y += piece.rotSpeed.y * 0.01;
		piece.mesh.rotation.z += piece.rotSpeed.z * 0.01;

		// ease scale toward 1 for the pop-in
		const s = piece.mesh.scale.x;
		if (s < 1) piece.mesh.scale.setScalar(Math.min(1, s + dt * 3));

		const distance = camera.position.distanceTo(piece.mesh.position);
		const depthFade = THREE.MathUtils.clamp(
			THREE.MathUtils.mapLinear(distance, 10, 23, 1, 0.35),
			0.35,
			1,
		);
		piece.material.opacity = depthFade;
	}

	// advance shards
	for (let i = shards.length - 1; i >= 0; i--) {
		const shard = shards[i];
		shard.life += dt;
		shard.velocity.y -= 6 * dt; // gravity
		shard.velocity.multiplyScalar(0.98); // drag
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

	camera.position.x += (pointer.x * 1.2 - camera.position.x) * 0.02;
	camera.position.y += (-pointer.y * 0.8 - camera.position.y) * 0.02;
	camera.lookAt(0, 0, 0);

	renderer.render(scene, camera);
	requestAnimationFrame(animate);
}

animate();
