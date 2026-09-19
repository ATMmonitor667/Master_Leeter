# Author-owned reference; never execute candidate submissions here.
def calibration_block(adjustments, target):
    first = {0: 0}
    total = 0
    best = [-1, -1]
    length = 0
    for end, value in enumerate(adjustments, 1):
        total += value
        start = first.get(total - target)
        if start is not None:
            size = end - start
            if size > length or (size == length and size > 0 and start < best[0]):
                best, length = [start, end], size
        first.setdefault(total, end)
    return best

