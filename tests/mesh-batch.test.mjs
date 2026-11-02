import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../vendor/three.module.js';
import { mergeRigidMeshes } from '../js/mesh-batch.js';
import { readFile, readdir } from 'node:fs/promises';

function fixture(){
  const root = new T.Group(); root.position.set(3, 5, 7); root.rotation.y = .4;
  const material = new T.MeshStandardMaterial();
  const meshes = [new T.Mesh(new T.BoxGeometry(), material), new T.Mesh(new T.BoxGeometry(), material)];
  meshes[1].position.x = 2;
  root.add(...meshes); root.updateMatrixWorld(true);
  return { root, meshes, material };
}

test('batching keeps bounds, triangles and UVs with fewer vertices', () => {
  const { root, meshes } = fixture();
  const before = new T.Box3().setFromObject(root);
  const uvs = meshes.flatMap(m => [...m.geometry.attributes.uv.array]);
  mergeRigidMeshes(T, root, meshes);
  assert.equal(root.children.length, 1);
  const g = root.children[0].geometry;
  assert.equal(g.index.count, 72);
  assert.equal(g.attributes.position.count, 48, 'old path expanded to 72 vertices');
  assert.deepEqual([...g.attributes.uv.array], uvs);
  const after = new T.Box3().setFromObject(root);
  assert.ok(before.min.distanceTo(after.min) < 1e-5);
  assert.ok(before.max.distanceTo(after.max) < 1e-5);
});

test('different textures and glass remain separate; turret mounts stay intact', () => {
  const { root, meshes } = fixture();
  const glass = new T.Mesh(new T.BoxGeometry(), new T.MeshPhysicalMaterial({ transparent: true, opacity: .6 }));
  const textured = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ map: new T.Texture() }));
  root.add(glass, textured); root.userData.partKey = 'turret';
  const position = root.position.clone();
  mergeRigidMeshes(T, root, [...meshes, glass, textured], false);
  assert.equal(root.children.length, 3);
  assert.equal(glass.parent, root); assert.equal(textured.parent, root);
  assert.equal(root.userData.partKey, 'turret'); assert.deepEqual(root.position, position);
  assert.equal(root.children.at(-1).castShadow, false);
});

test('single meshes are not detached or moved; missing UVs receive zero coordinates', () => {
  const { root, meshes } = fixture();
  meshes[0].geometry.deleteAttribute('uv');
  mergeRigidMeshes(T, root, [meshes[0]]);
  assert.equal(root.children.length, 2);
  mergeRigidMeshes(T, root, meshes);
  assert.ok(root.children[0].geometry.attributes.uv.array.slice(0,48).every(n=>n===0));
});

test('mirrored geometry keeps outward-facing triangle winding', () => {
  const { root, meshes } = fixture();
  meshes[1].scale.x = -1;
  mergeRigidMeshes(T, root, meshes);
  const g = root.children[0].geometry, p = g.attributes.position;
  for (let i=0; i<g.index.count; i+=3){
    const a = new T.Vector3().fromBufferAttribute(p,g.index.getX(i));
    const b = new T.Vector3().fromBufferAttribute(p,g.index.getX(i+1));
    const c = new T.Vector3().fromBufferAttribute(p,g.index.getX(i+2));
    const normal = new T.Vector3().fromBufferAttribute(g.attributes.normal,g.index.getX(i));
    assert.ok(b.sub(a).cross(c.sub(a)).dot(normal) > 0);
  }
});

test('one canonical URL per game module; hangar cancels deferred thumbnail work', async () => {
  const root = new URL('../js/', import.meta.url);
  for (const name of await readdir(root)) if (name.endsWith('.js')){
    assert.doesNotMatch(await readFile(new URL(name,root),'utf8'), /from ['"][^'"]+\.js\?v=/);
  }
  const hangar = await readFile(new URL('hangar.js',root),'utf8');
  assert.match(hangar,/IntersectionObserver/);
  assert.match(hangar,/S\.destroyed = true;\s*resetThumbQueue\(\)/);
});
