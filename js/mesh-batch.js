// Shared airframe/turret batching. Keep indices and UVs: expanding every triangle
// wasted vertex memory, and losing UVs erased the new component surface detail.
export function mergeRigidMeshes(T, root, meshes, castShadow = true){
  root.updateMatrixWorld(true);
  const batches = new Map(), inv = root.matrixWorld.clone().invert(), matrix = new T.Matrix4();
  for (const mesh of meshes){
    const m = mesh.material, g = mesh.geometry;
    // Glass needs per-object sorting; grouped materials must retain their groups.
    if (!m || Array.isArray(m) || m.transparent || !g?.attributes.position) continue;
    const key = [m.type, m.color?.getHexString(), m.metalness, m.roughness,
      m.emissive?.getHexString(), m.emissiveIntensity, m.side, m.vertexColors,
      m.map?.uuid, m.roughnessMap?.uuid, m.bumpMap?.uuid, m.bumpScale].join('|');
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(mesh);
  }
  const usedGeometries = new Set(), usedMaterials = new Set();
  for (const batch of batches.values()){
    if (batch.length < 2) continue;
    let vertices = 0, indices = 0;
    for (const m of batch){ vertices += m.geometry.attributes.position.count; indices += m.geometry.index?.count ?? m.geometry.attributes.position.count; }
    const pos = new Float32Array(vertices * 3), nor = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2);
    const color = batch[0].material.vertexColors ? new Float32Array(vertices * 3).fill(1) : null;
    const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    let v = 0, i = 0;
    for (const mesh of batch){
      const g = mesh.geometry.clone();
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(matrix.multiplyMatrices(inv, mesh.matrixWorld));
      pos.set(g.attributes.position.array, v * 3); nor.set(g.attributes.normal.array, v * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, v * 2);
      if (color && g.attributes.color) color.set(g.attributes.color.array, v * 3);
      const count = g.index?.count ?? g.attributes.position.count;
      const mirrored = matrix.determinant() < 0;
      for (let j = 0; j < count; j++){
        const source = mirrored ? j - j % 3 + [0, 2, 1][j % 3] : j;
        index[i++] = v + (g.index ? g.index.getX(source) : source);
      }
      v += g.attributes.position.count;
      g.dispose(); mesh.removeFromParent();
      usedGeometries.add(mesh.geometry); usedMaterials.add(mesh.material);
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new T.BufferAttribute(nor, 3));
    geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
    if (color) geometry.setAttribute('color', new T.BufferAttribute(color, 3));
    geometry.setIndex(new T.BufferAttribute(index, 1));
    const merged = new T.Mesh(geometry, batch[0].material.clone());
    merged.castShadow = castShadow; merged.receiveShadow = false;
    root.add(merged);
  }
  // A skipped mesh can still own a resource shared with a merged one.
  root.traverse(o => { usedGeometries.delete(o.geometry); usedMaterials.delete(o.material); });
  for (const g of usedGeometries) g.dispose();
  for (const m of usedMaterials) m.dispose();
}
