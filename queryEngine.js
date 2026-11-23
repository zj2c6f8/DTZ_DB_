function matchesFilter(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;

  for (const key in filter) {
    const condition = filter[key];
    const docValue = doc[key];

    if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
      for (const op in condition) {
        const target = condition[op];
        if (op === '$eq' && docValue !== target) return false;
        if (op === '$ne' && docValue === target) return false;
        if (op === '$gt' && !(docValue > target)) return false;
        if (op === '$gte' && !(docValue >= target)) return false;
        if (op === '$lt' && !(docValue < target)) return false;
        if (op === '$lte' && !(docValue <= target)) return false;
        if (op === '$in' && (!Array.isArray(target) || !target.includes(docValue))) return false;
      }
    } else {
      if (docValue !== condition) return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  const updatedDoc = { ...doc };

  if (update.$set) {
    Object.assign(updatedDoc, update.$set);
  }
  if (update.$inc) {
    for (const key in update.$inc) {
      updatedDoc[key] = (Number(updatedDoc[key]) || 0) + Number(update.$inc[key]);
    }
  }
  if (update.$unset) {
    for (const key in update.$unset) {
      delete updatedDoc[key];
    }
  }
  if (!update.$set && !update.$inc && !update.$unset) {
    Object.assign(updatedDoc, update);
  }

  return updatedDoc;
}

module.exports = { matchesFilter, applyUpdate };
