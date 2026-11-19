#include "llama.h"
#include "llama-memory-stats.h"
#include "ggml-backend.h"
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

struct pool_snapshot {
    std::string kind;
    uint64_t capacity = 0, occupied = 0, shared = 0, exclusive = 0, memberships = 0;
    std::map<llama_seq_id, uint64_t> sequence_cells;
};
using snapshot = std::map<const void *, pool_snapshot>;
static void observe(const llama_memory_stat_event * event, void * user_data) {
    auto & data = *static_cast<snapshot *>(user_data);
    if (event->event_type == LLAMA_MEMORY_STAT_POOL) {
        data[event->pool_identity] = {event->kind, event->capacity_cells, event->occupied_cells,
                                    event->shared_cells, event->exclusive_cells, 0, {}};
    } else if (event->event_type == LLAMA_MEMORY_STAT_MEMBERSHIP) {
        auto & pool = data.at(event->pool_identity);
        pool.memberships += event->occupied_cells;
        for (size_t i = 0; i < event->sequence_count; ++i) {
            pool.sequence_cells[event->sequence_ids[i]] += event->occupied_cells;
        }
    } else if (event->event_type == LLAMA_MEMORY_STAT_TENSOR) {
        assert(event->bytes > 0);
        assert(event->storage_identity);
    }
}
static snapshot inspect(llama_memory_t memory, const char * phase) {
    snapshot result;
    assert(llama_memory_get_cell_stats(memory, observe, &result));
    assert(result.size() == 2);
    for (const auto & item : result) {
        const auto & p = item.second;
        assert(p.capacity >= p.occupied);
        assert(p.occupied == p.shared + p.exclusive);
        assert(p.occupied == p.memberships);
        std::printf("%s %s capacity=%llu occupied=%llu shared=%llu exclusive=%llu seq0=%llu seq1=%llu\n",
            phase, p.kind.c_str(), (unsigned long long)p.capacity, (unsigned long long)p.occupied,
            (unsigned long long)p.shared, (unsigned long long)p.exclusive,
            (unsigned long long)(p.sequence_cells.count(0) ? p.sequence_cells.at(0) : 0),
            (unsigned long long)(p.sequence_cells.count(1) ? p.sequence_cells.at(1) : 0));
    }
    return result;
}
int main(int argc, char ** argv) {
    assert(argc == 2);
    ggml_backend_load_all();
    llama_backend_init();
    auto mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    auto * model = llama_model_load_from_file(argv[1], mp);
    assert(model);
    auto cp = llama_context_default_params();
    cp.n_ctx = 512; cp.n_batch = 32; cp.n_ubatch = 32; cp.n_seq_max = 2; cp.kv_unified = true;
    cp.n_threads = 4; cp.n_threads_batch = 4;
    cp.type_k = GGML_TYPE_Q8_0; cp.type_v = GGML_TYPE_Q8_0;
    cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;
    auto * context = llama_init_from_model(model, cp);
    assert(context);
    auto * memory = llama_get_memory(context);
    const auto empty = inspect(memory, "empty");
    for (const auto & item : empty) { assert(item.second.occupied == 0); }
    const auto * vocab = llama_model_get_vocab(model);
    llama_token tokens[16];
    const int n = llama_tokenize(vocab, "Hello", 5, tokens, 16, true, true);
    assert(n > 0 && n <= 4);
    assert(llama_decode(context, llama_batch_get_one(tokens, n)) == 0);
    llama_synchronize(context);
    const auto main = inspect(memory, "main");
    for (const auto & item : main) {
        assert(item.second.occupied > 0);
        assert(item.second.sequence_cells.at(0) == item.second.occupied);
        assert(item.second.shared == 0);
    }
    llama_memory_seq_cp(memory, 0, 1, -1, -1);
    const auto fork = inspect(memory, "copied");
    for (const auto & item : fork) {
        const auto & p = item.second;
        assert(p.occupied == main.at(item.first).occupied);
        assert(p.shared == p.occupied);
        assert(p.sequence_cells.at(0) == p.sequence_cells.at(1));
    }
    assert(llama_memory_seq_rm(memory, 1, -1, -1));
    const auto removed = inspect(memory, "removed-seq1");
    for (const auto & item : removed) {
        const auto & p = item.second;
        assert(p.occupied == main.at(item.first).occupied);
        assert(p.shared == 0);
        assert(p.sequence_cells.count(1) == 0);
        assert(p.sequence_cells.at(0) == main.at(item.first).sequence_cells.at(0));
    }
    assert(llama_memory_seq_rm(memory, 0, -1, -1));
    const auto cleared = inspect(memory, "removed-seq0");
    for (const auto & item : cleared) { assert(item.second.occupied == 0); }
    llama_free(context);
    llama_model_free(model);
    llama_backend_free();
    std::puts("All actual attention and recurrent cell ownership checks passed");
}
