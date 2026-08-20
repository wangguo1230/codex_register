export function createOwnedOperationLock() {
    let owner = null;

    function acquire(nextOwner) {
        if (owner) return false;
        owner = nextOwner;
        return true;
    }

    function release(currentOwner) {
        if (owner !== currentOwner) return false;
        owner = null;
        return true;
    }

    return {acquire, release, owner: () => owner};
}
