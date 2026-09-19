# Author-owned reference; never execute candidate submissions here.
import heapq

def job_order(count, prerequisites):
    outgoing = [[] for _ in range(count)]
    incoming = [0] * count
    for before, after in set(map(tuple, prerequisites)):
        outgoing[before].append(after)
        incoming[after] += 1
    ready = [job for job in range(count) if incoming[job] == 0]
    heapq.heapify(ready)
    result = []
    while ready:
        job = heapq.heappop(ready)
        result.append(job)
        for other in outgoing[job]:
            incoming[other] -= 1
            if incoming[other] == 0:
                heapq.heappush(ready, other)
    return result if len(result) == count else []

