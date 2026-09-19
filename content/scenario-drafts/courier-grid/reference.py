# Author-owned reference; never execute candidate submissions here.
from collections import deque

def fewest_moves(floor, start, destination):
    rows, columns = len(floor), len(floor[0])
    source, goal = tuple(start), tuple(destination)
    queue = deque([(source, 0)])
    seen = {source}
    while queue:
        (row, column), distance = queue.popleft()
        if (row, column) == goal:
            return distance
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = row + dr, column + dc
            cell = (nr, nc)
            if 0 <= nr < rows and 0 <= nc < columns and floor[nr][nc] == 0 and cell not in seen:
                seen.add(cell)
                queue.append((cell, distance + 1))
    return -1

